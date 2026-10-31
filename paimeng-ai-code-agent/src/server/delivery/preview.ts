import 'server-only';
import { createServer } from 'node:http';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, extname, resolve } from 'node:path';
import { getConfig } from '../infra/config';
import { ensureSafeDirectory, validateDeployKey } from '../workspace/workspace';
import { currentDelivery, legacyDelivery, resolveDelivery } from './delivery-store';
import type { CodeGenType } from '@/shared/contracts';
import { maxSelectedElements } from '@/shared/element-selection';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** 静态资源的 Content-Type；未知扩展名返回 null（调用方决定 404 还是拒绝）。 */
export function contentType(path: string) { return mime[extname(path)] ?? null; }

function editorBridge(parentOrigin: string) {
  return `<script data-paimeng-editor>(function(){
  var parentOrigin=${JSON.stringify(parentOrigin)};
  var MAX_SELECTED=${maxSelectedElements};
  var HOVER='paimeng-edit-hover';
  var SELECTED='paimeng-edit-selected';
  var STYLE_ID='paimeng-editor-style';
  var enabled=false;
  var hovered=null;
  var selected=[];
  function styleOnce(){
    if(document.getElementById(STYLE_ID))return;
    var style=document.createElement('style');
    style.id=STYLE_ID;
    style.textContent='.'+HOVER+'{outline:2px dashed #1890ff !important;outline-offset:2px !important;cursor:crosshair !important}.'+SELECTED+'{outline:3px solid #52c41a !important;outline-offset:2px !important;cursor:default !important}';
    (document.head||document.documentElement).appendChild(style);
  }
  function clearHover(){if(hovered){hovered.classList.remove(HOVER);hovered=null;}}
  function clearSelected(){for(var index=0;index<selected.length;index++)selected[index].classList.remove(SELECTED);selected=[];}
  function clearAll(){clearHover();clearSelected();}
  function classListOf(element){return typeof element.className==='string'?element.className.split(/\\s+/).filter(Boolean):[];}
  function selectorFor(element){
    var parts=[];
    var current=element;
    while(current&&current!==document.body&&current.nodeType===1){
      var part=current.tagName.toLowerCase();
      if(current.id){parts.unshift(part+'#'+CSS.escape(current.id));break;}
      var classes=classListOf(current).slice(0,3);
      if(classes.length)part+='.'+classes.map(function(name){return CSS.escape(name);}).join('.');
      var parent=current.parentElement;
      if(parent){
        var siblings=Array.prototype.filter.call(parent.children,function(child){return child.tagName===current.tagName;});
        part+=':nth-of-type('+(siblings.indexOf(current)+1)+')';
      }
      parts.unshift(part);
      current=parent;
    }
    return 'body>'+parts.join('>');
  }
  function elementInfo(element){
    return {
      tagName:element.tagName.toLowerCase(),
      id:element.id||'',
      className:(typeof element.className==='string'?element.className:'').trim().slice(0,512),
      textContent:(element.textContent||'').trim().slice(0,2000),
      selector:selectorFor(element),
      pagePath:location.pathname+location.hash
    };
  }
  function reportSelected(){parent.postMessage({type:'ELEMENTS_SELECTED',elements:selected.map(elementInfo)},parentOrigin);}
  function toggleSelected(element){
    var index=selected.indexOf(element);
    if(index>=0){selected.splice(index,1);element.classList.remove(SELECTED);reportSelected();return;}
    if(selected.length>=MAX_SELECTED){parent.postMessage({type:'SELECTION_LIMIT',max:MAX_SELECTED},parentOrigin);return;}
    selected.push(element);element.classList.add(SELECTED);reportSelected();
  }
  window.addEventListener('message',function(event){
    if(event.source!==parent||event.origin!==parentOrigin||!event.data||typeof event.data!=='object')return;
    if(event.data.type==='TOGGLE_EDIT_MODE'){
      enabled=event.data.editMode===true;
      if(enabled)styleOnce();
      clearAll();
    }else if(event.data.type==='CLEAR_ALL_EFFECTS'){
      enabled=false;clearAll();
    }else if(event.data.type==='CLEAR_SELECTION'){
      var selector=event.data.selector;
      if(typeof selector==='string'){
        for(var index=selected.length-1;index>=0;index--){
          if(selectorFor(selected[index])===selector){selected[index].classList.remove(SELECTED);selected.splice(index,1);}
        }
      }else clearSelected();
    }
  });
  document.addEventListener('mouseover',function(event){
    if(!enabled||!(event.target instanceof HTMLElement))return;
    var target=event.target;
    if(target===document.body||target===document.documentElement)return;
    if(target.tagName==='SCRIPT'||target.tagName==='STYLE')return;
    if(target===hovered||selected.indexOf(target)>=0)return;
    clearHover();
    target.classList.add(HOVER);
    hovered=target;
  },true);
  document.addEventListener('mouseout',function(event){
    if(!enabled)return;
    var target=event.target;
    if(!(target instanceof HTMLElement))return;
    if(!event.relatedTarget||!(target.contains(event.relatedTarget)))clearHover();
  },true);
  document.addEventListener('click',function(event){
    if(!enabled||!(event.target instanceof HTMLElement))return;
    event.preventDefault();event.stopPropagation();
    var target=event.target;
    if(target===document.body||target===document.documentElement)return;
    if(target.tagName==='SCRIPT'||target.tagName==='STYLE')return;
    clearHover();
    toggleSelected(target);
  },true);
  parent.postMessage({type:'EDITOR_READY'},parentOrigin);
})();</script>`;
}

/** `/preview|delivery/<codeGenType>_<appId>/...` 里的应用标识。 */
function appFromKey(key: string): { id: string; codeGenType: CodeGenType } {
  const match = key.match(/^(html|multi_file|vue_project|react_project)_([1-9]\d{0,19})$/);
  if (!match) throw new Error('应用标识不合法');
  return { codeGenType: match[1] as CodeGenType, id: match[2] };
}

export async function createPreviewServer(options: { runtimeRoot?: string } = {}) {
  const config = getConfig();
  const origin = new URL(config.previewOrigin);
  // 测试可以指向临时运行目录；生产默认仍是 getConfig().runtimeRoot。
  const root = await ensureSafeDirectory(resolve(options.runtimeRoot ?? config.runtimeRoot));
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
        const fixed = path.match(/^\/delivery\/([^/]+)\/([^/]+)(\/.*)?$/);
        const match = fixed ?? path.match(/^\/(preview|deploy)\/([^/]+)(\/.*)?$/);
        if (!match) { res.writeHead(404); res.end(); return; }
        const rest = match[3];
        const key = fixed ? fixed[1] : match[2];
        // 先校验标识再重定向，保持 deploy 与 preview 原有的 400 语义。
        const deployKey = !fixed && match[1] === 'deploy' ? validateDeployKey(key) : null;
        const app = deployKey === null ? appFromKey(key) : null;
        if (!rest) { res.writeHead(308, { Location: url.pathname + '/' }); res.end(); return; }
        if (deployKey !== null) {
          directory = join(root, 'deploy', deployKey);
        } else if (app && fixed) {
          // 固定交付路由：只看这一个不可变目录，不跟随指针。
          const resolved = await resolveDelivery({ app, deliveryId: fixed[2], runtimeRoot: root });
          if (!resolved) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('交付不存在'); return; }
          directory = resolved.directory;
        } else if (app) {
          // 预览入口：有指针就服务该交付；没有指针才回退旧 code_output（legacy），两者不混用。
          const pointer = await currentDelivery({ app, runtimeRoot: root });
          if (pointer) {
            const resolved = await resolveDelivery({ app, deliveryId: pointer.deliveryId, runtimeRoot: root });
            if (!resolved) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('交付不存在'); return; }
            directory = resolved.directory;
          } else directory = legacyDelivery(app, root).directory;
        } else throw new Error('应用标识不合法');
        asset = rest.slice(1) || 'index.html';
      }
      const segments = asset.split('/');
      if (segments.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('路径被拒绝');
      const directoryReal = await realpath(directory);
      if (directoryReal !== directory) throw new Error('目录不允许软链接');
      let file = join(directory, asset);
      if (!contentType(file)) {
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
        'Content-Type': contentType(file) ?? 'application/octet-stream', 'Content-Length': contents.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors ${config.appOrigin}; sandbox allow-scripts allow-same-origin`,
      });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400, { 'Cache-Control': 'no-store' });
      res.end('资源不可访问');
    }
  });
}
