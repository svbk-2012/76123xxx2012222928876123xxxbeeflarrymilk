import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

async function run() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // Initialize Gemini client lazily
  let aiClient: GoogleGenAI | null = null;
  function getGemini(): GoogleGenAI {
    if (!aiClient) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        console.warn("GEMINI_API_KEY environment variable is not defined. AI features will be unavailable.");
        throw new Error("GEMINI_API_KEY is required for AI features");
      }
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });
    }
    return aiClient;
  }

  // 1. API: Page Proxy
  app.get("/api/proxy", async (req, res) => {
    const urlParam = req.query.url as string;
    const userAgentType = (req.query.userAgent as string) || 'desktop';

    if (!urlParam) {
      return res.status(400).send("URL parameter is required");
    }

    let targetUrl = urlParam.trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = "https://" + targetUrl;
    }

    try {
      // Choose User Agent
      let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      if (userAgentType === 'mobile') {
        userAgent = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
      } else if (userAgentType === 'bot') {
        userAgent = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
      }

      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";

      // If it's HTML, we'll process it and inject our interception scripts
      if (contentType.toLowerCase().includes("text/html")) {
        let html = await response.text();

        // Resolve actual redirected URL
        const baseHrefUrl = response.url || targetUrl;

        // Strip Content Security Policy meta tags
        html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "");
        html = html.replace(/<meta\s+name=["']content-security-policy["'][^>]*>/gi, "");
        
        // Inject our bases and scripts
        const injection = `
          <base href="${baseHrefUrl}">
          <meta charset="utf-8">
          <script>
            // Override window.open to communicate with parent
            window.open = function(url) {
              if (url) {
                const absUrl = new URL(url, document.baseURI).href;
                window.parent.postMessage({ type: 'navigate-new-tab', url: absUrl }, '*');
              }
              return null;
            };

            // Override alert, confirm, prompt to prevent blockages
            window.alert = function(msg) { console.log("Proxied Alert:", msg); };
            window.confirm = function(msg) { console.log("Proxied Confirm:", msg); return true; };
            window.prompt = function(msg) { console.log("Proxied Prompt:", msg); return ""; };

            // Intercept all link clicks (anchors)
            document.addEventListener('click', function(e) {
              const target = e.target.closest('a');
              if (target) {
                const href = target.getAttribute('href');
                const targetAttribute = target.getAttribute('target');
                
                if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                  e.preventDefault();
                  const absoluteUrl = new URL(href, document.baseURI).href;
                  
                  if (targetAttribute === '_blank') {
                    window.parent.postMessage({ type: 'navigate-new-tab', url: absoluteUrl }, '*');
                  } else {
                    window.parent.postMessage({ type: 'navigate', url: absoluteUrl }, '*');
                  }
                }
              }
            }, true);

            // Intercept form submissions
            document.addEventListener('submit', function(e) {
              const form = e.target;
              e.preventDefault();
              const action = form.getAttribute('action') || '';
              const absoluteAction = new URL(action, document.baseURI).href;
              const method = (form.getAttribute('method') || 'get').toLowerCase();

              const formData = new FormData(form);
              const params = new URLSearchParams();
              const payload = {};

              for (const [key, value] of formData.entries()) {
                if (typeof value === 'string') {
                  params.append(key, value);
                  payload[key] = value;
                }
              }

              let finalUrl = absoluteAction;
              if (method === 'get') {
                const separator = finalUrl.indexOf('?') !== -1 ? '&' : '?';
                finalUrl += separator + params.toString();
                window.parent.postMessage({ type: 'navigate', url: finalUrl }, '*');
              } else {
                window.parent.postMessage({ 
                  type: 'navigate-post', 
                  url: finalUrl,
                  data: payload
                }, '*');
              }
            }, true);

            // Handle scrolling details back to client for analytics and reading tracking
            window.addEventListener('scroll', function() {
              const totalHeight = document.documentElement.scrollHeight - window.innerHeight;
              if (totalHeight > 0) {
                const progress = (window.scrollY / totalHeight) * 100;
                window.parent.postMessage({ type: 'scroll-progress', value: progress }, '*');
              }
            });
          </script>
        `;

        // Insert scripts immediately inside <head> if possible, else <body>, else beginning
        let headIndex = html.indexOf("<head>");
        if (headIndex === -1) {
          headIndex = html.indexOf("<HEAD>");
        }

        if (headIndex !== -1) {
          const insertAt = headIndex + 6;
          html = html.slice(0, insertAt) + injection + html.slice(insertAt);
        } else {
          let bodyIndex = html.indexOf("<body>");
          if (bodyIndex === -1) {
            bodyIndex = html.indexOf("<BODY>");
          }
          if (bodyIndex !== -1) {
            html = html.slice(0, bodyIndex + 6) + injection + html.slice(bodyIndex + 6);
          } else {
            html = injection + html;
          }
        }

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(html);
      } else {
        // Direct script, style sheet, or asset fetch request.
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        res.setHeader("Content-Type", contentType);
        return res.send(buffer);
      }

    } catch (error: any) {
      console.error("Proxy Error:", error);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              margin: 0;
              padding: 40px;
              background: #f8fafc;
              color: #1e293b;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 80vh;
              text-align: center;
            }
            .container {
              max-width: 500px;
              background: white;
              padding: 32px;
              border-radius: 12px;
              box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05);
            }
            h1 {
              font-size: 22px;
              font-weight: 600;
              margin-bottom: 12px;
              color: #dc2626;
            }
            p {
              font-size: 14px;
              color: #64748b;
              line-height: 1.6;
              margin-bottom: 20px;
            }
            .error-details {
              font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
              background: #f1f5f9;
              padding: 12px;
              border-radius: 8px;
              font-size: 12px;
              word-break: break-all;
              margin-bottom: 24px;
              color: #475569;
              text-align: left;
              border: 1px solid #e2e8f0;
            }
            .button {
              background: #2563eb;
              color: white;
              padding: 10px 20px;
              border-radius: 8px;
              text-decoration: none;
              font-size: 14px;
              font-weight: 500;
              display: inline-block;
              transition: background 0.2s;
            }
            .button:hover {
              background: #1d4ed8;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Failed to Load Webpage</h1>
            <p>The proxy could not resolve or load this address. The website might be offline, block anonymous scraper connections, or have invalid SSL configuration.</p>
            <div class="error-details">Request URL: ${targetUrl}<br>Details: ${error.message || error}</div>
            <a class="button" href="javascript:window.location.reload();">Retry Request</a>
          </div>
        </body>
        </html>
      `);
    }
  });

  // 2. API: Assistant Summarization / Web Companion
  app.post("/api/ai/chat", async (req, res) => {
    const { prompt, pageText, pageUrl, history } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    try {
      const ai = getGemini();
      const systemInstruction = `
        You are the Proxy Browser AI Assistant, an elite web co-pilot.
        You help users extract insights, summarize articles, look up definitions, and research information on the page they are currently visiting.
        
        Current URL being viewed: ${pageUrl || 'unknown'}
        Page Content Snippet (extracted text):
        ---
        ${pageText ? pageText.substring(0, 15000) : 'No page content available or page failed to load.'}
        ---

        Instructions:
        1. Answer the user's questions clearly, directly, and objectively based on the page content when they ask about the page.
        2. If the user asks about something unrelated, answer professionally while gently reminding them you are their web companion.
        3. Format replies beautifully using Markdown. Use lists, tables, bold text, and subheaders to keep content scannable.
      `;

      const contents: any[] = [];
      
      if (history && Array.isArray(history)) {
        history.forEach((turn: { role: string; text: string }) => {
          contents.push({
            role: turn.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: turn.text }]
          });
        });
      }

      contents.push({
        role: 'user',
        parts: [{ text: prompt }]
      });

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: contents,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.3,
        }
      });

      res.json({ text: response.text });
    } catch (error: any) {
      console.error("AI Error:", error);
      res.status(500).json({ error: error.message || "Failed to generate AI response" });
    }
  });

  // 3. API: Reader Mode Extractor
  app.post("/api/reader-mode", async (req, res) => {
    const { html, url } = req.body;
    
    if (!html) {
      return res.status(400).json({ error: "HTML is required" });
    }

    try {
      const ai = getGemini();
      const systemPrompt = `
        You are a Reader Mode content extractor. Your job is to take raw HTML from a webpage and cleanly extract ONLY the main article or page content.
        Format the extracted content as clean, gorgeous markdown. Remove all headers, navbars, sidebars, advertisements, cookie notice popups, comments sections, and extraneous footers.
        Return ONLY valid JSON with this exact structure:
        {
          "title": "Title of the website, article, or document",
          "author": "Author name or null if not detected",
          "publishedDate": "Date or null if not detected",
          "markdown": "Clean markdown representation of the main page text with appropriate titles, code blocks, lists and sections."
        }
        Do not return any enclosing triple backticks like \`\`\`json. Just return raw JSON.
      `;

      const htmlSnippet = html.substring(0, 100000);

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: [
          { role: 'user', parts: [{ text: `URL: ${url}\n\nHTML:\n${htmlSnippet}` }] }
        ],
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      });

      try {
        const parsed = JSON.parse(response.text || "{}");
        res.json(parsed);
      } catch (parseErr) {
        console.error("JSON parsing failed, falling back", parseErr);
        res.json({
          title: "Extracted Webpage",
          author: null,
          publishedDate: null,
          markdown: response.text || "Failed to parse content markdown."
        });
      }
    } catch (error: any) {
      console.error("Reader Mode Error:", error);
      res.status(500).json({ error: error.message || "Failed to extract clean reader content" });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

run().catch(err => {
  console.error("Failed to start server:", err);
});
