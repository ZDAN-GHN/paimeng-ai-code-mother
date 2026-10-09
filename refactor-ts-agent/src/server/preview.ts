import 'server-only';
import { createServer } from 'node:http';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, extname } from 'node:path';
import { getConfig } from './config';
import { ensureRuntime, validateDeployKey } from './workspace';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function editorBridge(parentOrigin: string) {
  return `<script data-paimeng-editor>(function(){const parentOrigin=${JSON.stringify(parentOrigin)};let enabled=false;let selected=null;function clear(){if(selected){selected.style.removeProperty('outline');selected=null}}function selector(element){if(element.id)return '#'+CSS.escape(element.id);let parts=[];while(element&&element!==document.body){const siblings=Array.from(element.parentElement?.children||[]).filter(e=>e.tagName===element.tagName);parts.unshift(element.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(element)+1)+')');element=element.parentElement}return 'body>'+parts.join('>')}window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==parentOrigin||!event.data||typeof event.data!=='object')return;if(event.data.type==='TOGGLE_EDIT_MODE'){enabled=event.data.editMode===true;if(!enabled)clear()}if(event.data.type==='CLEAR_ALL_EFFECTS')clear()});document.addEventListener('click',event=>{if(!enabled||!(event.target instanceof HTMLElement))return;event.preventDefault();event.stopPropagation();clear();selected=event.target;selected.style.outline='2px solid #cb573e';parent.postMessage({type:'ELEMENT_SELECTED',elementInfo:{tagName:selected.tagName.toLowerCase(),selector:selector(selected),textContent:(selected.textContent||'').slice(0,2000),pagePath:location.pathname}},parentOrigin)},true);parent.postMessage({type:'EDITOR_READY'},parentOrigin)})();</script>`;
}

export async function createPreviewServer() {
  const config = getConfig();
  const origin = new URL(config.previewOrigin);
  const root = await ensureRuntime();
  return createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return; }
      if (req.headers.host !== origin.host) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url ?? '/', config.previewOrigin);
      const path = decodeURIComponent(url.pathname);
      if (path.includes('\\') || path.includes('\0')) throw new Error('路径不合法');
      let directory: string;
      let asset: string;
      const cover = path.match(/^\/covers\/([^/]+)\.png$/);
      if (cover) { directory = join(root, 'covers'); asset = validateDeployKey(cover[1]) + '.png'; }
      else {
        const match = path.match(/^\/(preview|deploy)\/([^/]+)(\/.*)?$/);
        if (!match) { res.writeHead(404); res.end(); return; }
        const key = match[2];
        if (match[1] === 'deploy') directory = join(root, 'deploy', validateDeployKey(key));
        else {
          const project = key.match(/^(html|multi_file|vue_project)_([1-9]\d{0,19})$/);
          if (!project) throw new Error('应用标识不合法');
          directory = join(root, 'code_output', key, ...(project[1] === 'vue_project' ? ['dist'] : []));
        }
        if (!match[3]) { res.writeHead(308, { Location: url.pathname + '/' }); res.end(); return; }
        asset = match[3].slice(1) || 'index.html';
      }
      const segments = asset.split('/');
      if (segments.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('路径被拒绝');
      const directoryReal = await realpath(directory);
      if (directoryReal !== directory) throw new Error('目录不允许软链接');
      let file = join(directory, asset);
      if (!mime[extname(file)]) {
        if (extname(file)) { res.writeHead(404); res.end(); return; }
        file = join(directory, 'index.html');
      }
      const fileReal = await realpath(file);
      const rel = relative(directoryReal, fileReal);
      if (rel.startsWith('..') || isAbsolute(rel) || fileReal !== file) throw new Error('文件不允许软链接');
      const info = await lstat(file);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('文件不合法');
      let contents = await readFile(file);
      if (extname(file) === '.html') {
        const html = contents.toString();
        const script = editorBridge(config.appOrigin);
        contents = Buffer.from(/<\/body>/i.test(html) ? html.replace(/<\/body>/i, script + '</body>') : html + script);
      }
      res.writeHead(200, {
        'Content-Type': mime[extname(file)], 'Content-Length': contents.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors ${config.appOrigin}; sandbox allow-scripts allow-same-origin`,
      });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400, { 'Cache-Control': 'no-store' });
      res.end('资源不可访问');
    }
  });
}
