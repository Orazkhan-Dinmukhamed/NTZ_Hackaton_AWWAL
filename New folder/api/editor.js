const fs = require('fs');
const path = require('path');

module.exports = function handler(req, res) {
  try {
    // 👉 Определяем путь
    let requestPath = req.url.split('?')[0];

    // 👉 Главная страница
    if (requestPath === '/' || requestPath === '') {
      requestPath = '/index.html';
    }

    // 👉 Если не html — отдаём index
    if (!requestPath.endsWith('.html')) {
      requestPath = '/index.html';
    }

    const filePath = path.join(process.cwd(), requestPath);

    // 👉 Проверка существования
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      return res.end('Page not found');
    }

    // 👉 Читаем HTML
    let html = fs.readFileSync(filePath, 'utf8');

    // 👉 ENV переменные
    const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
    const groqKey     = process.env.groq_api || '';

    // 👉 Инжекция
    const injection = `
<script>
  window.__ENV = {
    SUPABASE_ANON_KEY: ${JSON.stringify(supabaseKey)},
    GROQ_API: ${JSON.stringify(groqKey)}
  };
</script>
`;

    // 👉 Вставляем перед </head>
    if (html.includes('</head>')) {
      html = html.replace(/<\/head>/i, injection + '</head>');
    } else {
      // если нет head — вставим в начало
      html = injection + html;
    }

    // 👉 Ответ
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(html);

  } catch (err) {
    console.error('EDITOR ERROR:', err);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
};