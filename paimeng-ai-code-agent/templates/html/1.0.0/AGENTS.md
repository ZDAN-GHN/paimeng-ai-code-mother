# 静态网站约定

- 保留 index.html 作为唯一入口。
- 只写 index.html，样式放 <style>、脚本放 <script>，不要拆分。
- 不要写 package.json、vite.config.*、tsconfig.json，不要使用 Vue/React/JSX/TS，不要引入任何构建工具或 npm 依赖。平台直接静态托管，没有构建步骤。
- 需要框架或组件化时，改用 Vue/React 模板新建应用。
- 图片等素材放 assets/ 并使用相对路径引用；联网导入的图片由平台写入该目录。
- 不要手改平台文件 assets/sources.json 与 assets/credits.html。
- 使用外部素材时，在页面保留来源链接与授权说明。
- 优先复用已有设计令牌、.container、.grid 与 .card，避免重复造样式。
- 不要引入 Bootstrap/Tailwind CDN 等外部 CSS 框架。
