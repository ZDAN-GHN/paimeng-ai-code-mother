const cards = [
  { title: '开始创作', description: '在这里展示网站的主要内容。' },
  { title: '组织内容', description: '复用卡片与栅格，让不同屏幕都易于阅读。' },
];
const grid = document.createElement('section');
grid.className = 'grid';
grid.setAttribute('aria-label', '内容示例');
for (const item of cards) {
  const card = document.createElement('article');
  card.className = 'card';
  const title = document.createElement('h2');
  title.textContent = item.title;
  const description = document.createElement('p');
  description.textContent = item.description;
  card.append(title, description);
  grid.append(card);
}
document.querySelector('#app').append(grid);
document.querySelector('#year').textContent = String(new Date().getFullYear());
