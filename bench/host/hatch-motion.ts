// Ported from the Codex host harness (control/hatch-motion.ts). Run it through bench/gate/gate.ts, which holds the
// host lock and sets GATE_OUT_DIR (evidence directory) and GATE_MAP (shared-v8 fixture). See docs/performance/webgl-rewrite/GATE.md.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
const root = resolve(import.meta.dirname, "../.."); // repo root: bench/host -> ../..
const dist = resolve(root, "dist");
const output = resolve(process.env.GATE_OUT_DIR || process.cwd(), process.env.SMOKE_NAME || "gpu-smoke");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const server = createServer((request, response) => {
  const path = resolve(dist, "." + new URL(request.url || "/", "http://localhost").pathname);
  if (!path.startsWith(dist + "/") && path !== dist) return void response.writeHead(403).end();
  try { const file = path === dist ? resolve(dist, "index.html") : path; response.setHeader("content-type", (mime as Record<string, string>)[extname(file)] || "application/octet-stream"); response.end(readFileSync(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw Error("No server");
const origin = "http://127.0.0.1:" + address.port;
const browser = await chromium.launch({headless:true,channel:"chromium",args:["--use-angle=metal","--enable-gpu"]});
const report = {diagnosticNoMsaa:process.env.SMOKE_NO_MSAA==="1",diagnosticOpaqueCanvas:process.env.SMOKE_OPAQUE_CANVAS==="1",diagnosticHiddenRelief:process.env.SMOKE_HIDE_RELIEF==="1",runStartedUtc:new Date().toISOString(),errors:[] as string[], warnings:[] as string[], failure:null as string | null, status:null as unknown, diff:null as unknown, animation:null as unknown};
try {
 const context = await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:Number(process.env.SMOKE_DPR || 1),serviceWorkers:"block"});
 if(process.env.SMOKE_NO_MSAA==="1")await context.addInitScript(()=>{(globalThis as any).__benchNoMsaa=true;});
 if(process.env.SMOKE_OPAQUE_CANVAS==="1")await context.addInitScript(()=>{(globalThis as any).__benchOpaqueCanvas=true;});
 if(process.env.SMOKE_OPAQUE_CANVAS==="1" || process.env.SMOKE_NO_MSAA==="1")await context.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;(HTMLCanvasElement.prototype as any).getContext=function(kind:string,options:any){return (original as any).call(this,kind,kind==="webgl2"?{...options,...((globalThis as any).__benchOpaqueCanvas?{alpha:false}:{}),...((globalThis as any).__benchNoMsaa?{antialias:false}:{})}:options);};});
 await context.addInitScript(() => {localStorage.setItem("autosaveInterval","0");localStorage.setItem("azgaarAssistant","hide");});
 const scripts=["bridge.js","bridge-mutations.js",...readdirSync(resolve(root,"mcp/src/bridge-ext")).filter(n=>n.endsWith(".js")).sort().map(n=>"bridge-ext/"+n)];
 await context.addInitScript(scripts.map(n=>readFileSync(resolve(root,"mcp/src",n),"utf8")).join("\n"));
 await context.route("**/*",route=>new URL(route.request().url()).origin===origin||(route.request().method()==="GET"&&new URL(route.request().url()).hostname==="fonts.gstatic.com")?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(90000);
 page.on("pageerror",e=>report.errors.push(e.message));page.on("console",m=>{if(["warning","error"].includes(m.type())&&report.warnings.length<50)report.warnings.push(m.text().slice(0,1000));});page.on("dialog",d=>d.dismiss());
 await page.goto(origin+"/?local&seed=7319&width=1280&height=720&renderer=gpu");
 await page.evaluate(async ({text,hideRelief})=>{const w=globalThis as any;const ready=await w.__tupaia.call("ready",{timeoutMs:120000});if(!ready.ok)throw Error(JSON.stringify(ready));await w.__tupaia.fns.loadMap({text,timeoutMs:120000});const shown=await w.__tupaia.call("display",hideRelief?{on:["heightmap"],off:["relief"]}:{on:["heightmap","relief"]});if(!shown.ok)throw Error(JSON.stringify(shown));await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);},{text:readFileSync(process.env.GATE_MAP||"/tmp/tupaia-navigation-shared-v8.map","utf8"),hideRelief:process.env.SMOKE_HIDE_RELIEF==="1"});

 await page.evaluate(()=>{
  const w=globalThis as any,ns="http://www.w3.org/2000/svg",svg=document.querySelector("#map")!,view=svg.querySelector("#viewbox")!;
  w.d3.select("#tradeAnimation").selectAll("*").interrupt();
  for(const e of [...view.children]){(e as SVGElement).style.display="none";if(e.id==="zones")e.id="zones-before-synthetic";}
  const pattern=document.createElementNS(ns,"pattern");
  pattern.id="gpu-hatch-motion-test";pattern.setAttribute("patternUnits","userSpaceOnUse");pattern.setAttribute("width","6");pattern.setAttribute("height","6");pattern.setAttribute("patternTransform","rotate(45)");
  pattern.innerHTML='<path d="M0 0L0 6" stroke="#f00" stroke-width="1"/>';
  svg.querySelector("defs")!.append(pattern);
  const background=document.createElementNS(ns,"rect");for(const [k,v]of Object.entries({x:"-5000",y:"-5000",width:"10000",height:"10000",fill:"#fff"}))background.setAttribute(k,v);
  view.append(background);
  const zones=document.createElementNS(ns,"g");zones.id="zones";
  zones.innerHTML='<path d="M-5000 -5000H5000V5000H-5000Z" fill="url(#gpu-hatch-motion-test)"/>';zones.style.opacity="1";view.append(zones);
  w.d3.select(svg).call((0,eval)("zoom").transform,w.d3.zoomIdentity);
  w.updateZoneHatching(1);
 });
 await page.waitForFunction(()=>{const s=(globalThis as any).rendererStatus?.();return s?.active==="gpu"&&s.gpu?.canvasVisible&&!s.gpu.pending&&!s.gpu.refinementPending;},{},{timeout:30000});
 const before=await page.evaluate(()=>(globalThis as any).rendererStatus?.().gpu);
 const snapshots=[];
 for(const zoom of [1,2,4,8]){
  await page.evaluate(async k=>{const w=globalThis as any;w.gpuRenderer.camera({scale:k,x:0,y:0,exact:false});await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));},zoom);
  const png=await page.screenshot({path:output+"-k"+zoom+".png",clip:{x:256,y:200,width:256,height:256}});
  snapshots.push({zoom,png:png.toString("base64"),status:await page.evaluate(()=>(globalThis as any).rendererStatus?.().gpu)});
 }
 await page.evaluate(async()=>{(globalThis as any).gpuRenderer.camera({scale:8,x:3,y:0,exact:false});await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));});
 const pan=(await page.screenshot({path:output+"-pan.png",clip:{x:256,y:200,width:256,height:256}})).toString("base64");
 const comparisons=await page.evaluate(async({snapshots,pan,dpr})=>{
  const decode=async(data:string)=>{const i=new Image();i.src="data:image/png;base64,"+data;await i.decode();const c=document.createElement("canvas");c.width=i.width;c.height=i.height;const x=c.getContext("2d")!;x.drawImage(i,0,0);return x.getImageData(0,0,c.width,c.height);};
  const base=await decode(snapshots[0].png),rows=[];
  for(const s of [...snapshots.map(s=>({zoom:s.zoom,data:s.png,shift:0})),{zoom:"pan",data:pan,shift:3*dpr}]){
   const actual=await decode(s.data);let max=0,over16=0,total=0;
   for(let y=0;y<base.height;y++)for(let x=0;x<base.width-s.shift;x++){
    let delta=0;for(let c=0;c<3;c++)delta=Math.max(delta,Math.abs(base.data[(y*base.width+x)*4+c]-actual.data[(y*base.width+x+s.shift)*4+c]));
    max=Math.max(max,delta);if(delta>16)over16++;total++;
   }
   rows.push({zoom:s.zoom,maxDelta:max,over16Fraction:over16/total});
  }
  return rows;
 },{snapshots,pan,dpr:Number(process.env.SMOKE_DPR||1)});
 (report as any).hatchMotion={syntheticFixture:true,nominalScreenPitchCssPx:6,rotationDegrees:45,cameraOnlyNoSvgUpdates:true,before,comparisons,after:snapshots.map(({zoom,status})=>({zoom,status})),noReprepare:snapshots.every(s=>s.status.prepares===before.prepares)};
 if(comparisons.some(r=>r.over16Fraction>.001)||(report as any).hatchMotion.noReprepare!==true)report.failure="Hatch camera-only pitch/phase regression";
} catch(e){report.failure=String(e);} finally {if(report.warnings.some(w=>/GL_INVALID_|Feedback loop/i.test(w)))report.failure??="WebGL validation failure";writeFileSync(output+".json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
