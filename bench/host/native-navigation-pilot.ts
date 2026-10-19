// Ported from the Codex host harness (control/native-navigation-pilot.ts). Run it through bench/gate/gate.ts, which holds the
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
  try { const file = path === dist ? resolve(dist, "index.html") : path; response.setHeader("content-type", mime[extname(file)] || "application/octet-stream"); response.end(readFileSync(file)); }
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
 await page.goto(origin+"/?local&seed=7319&width=1280&height=720&renderer="+(process.env.NAV_RENDERER||"gpu"));
 await page.evaluate(async ({text,hideRelief})=>{const w=globalThis as any;const ready=await w.__tupaia.call("ready",{timeoutMs:120000});if(!ready.ok)throw Error(JSON.stringify(ready));await w.__tupaia.fns.loadMap({text,timeoutMs:120000});const shown=await w.__tupaia.call("display",hideRelief?{on:["heightmap"],off:["relief"]}:{on:["heightmap","relief"]});if(!shown.ok)throw Error(JSON.stringify(shown));await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);},{text:readFileSync(process.env.GATE_MAP||"/tmp/tupaia-navigation-shared-v8.map","utf8"),hideRelief:process.env.SMOKE_HIDE_RELIEF==="1"});

 (report as any).contextProperties=await page.evaluate(()=>{const gl=(document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement)?.getContext("webgl2");return gl?{attributes:gl.getContextAttributes(),samples:gl.getParameter(gl.SAMPLES)}:null;});
 const arm=process.env.NAV_RENDERER||"gpu";
 const session=await context.newCDPSession(page);
 const summarize=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.floor(s.length*.5)]||0,p95:s[Math.min(s.length-1,Math.floor(s.length*.95))]||0,max:s.at(-1)||0};};
 const runs=[];
 for(const world of ["shared","100k"]){
  if(world==="100k")await page.evaluate(async()=>{const w=globalThis as any;await w.__tupaia.fns.generateMap({cells:100000,seed:"7319",template:"continents",width:1280,height:720});await w.__tupaia.call("display",{on:["heightmap","relief"]});await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);});
  for(const gesture of ["pan-near","pan-wide","wheel-zoom"]){
   const k=gesture==="wheel-zoom"?3.5:8;
   await page.evaluate(k=>{const w=globalThis as any;w.d3.select("#map").call((0,eval)("zoom").transform,w.d3.zoomIdentity.translate(640-w.graphWidth*k/2,360-w.graphHeight*k/2).scale(k));},k);
   const readyStart=Date.now();
   await page.evaluate(async()=>{const w=globalThis as any;await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);});
   if(arm==="gpu")await page.waitForFunction(()=>{const s=(globalThis as any).rendererStatus?.();return s?.active==="gpu"&&s.gpu?.canvasVisible&&!s.gpu.pending&&!s.gpu.refinementPending;},{},{timeout:30000});
   const readyWaitMs=Date.now()-readyStart;
   const idle=await page.evaluate(()=>new Promise<number[]>(resolve=>{const times:number[]=[];let previous=0;const tick=(t:number)=>{if(previous)times.push(t-previous);previous=t;if(times.length<120)requestAnimationFrame(tick);else resolve(times)};requestAnimationFrame(tick);}));
   await page.evaluate(()=>{
    const w=globalThis as any;
    const state=w.__nativeNav={running:true,intervals:[] as number[],events:[] as number[],tasks:[] as number[],gpuFrames:0,frames:0,previous:0,preparesAtStart:w.rendererStatus?.().gpu?.prepares||0,preparesDuring:[] as number[],movingFrames:0,cameras:[] as number[][]};
    const event=(e:Event)=>{const stamp=e.timeStamp;requestAnimationFrame(()=>state.events.push(performance.now()-stamp));};
    window.addEventListener("mousemove",event,true);window.addEventListener("wheel",event,true);
    const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())state.tasks.push(e.duration)});
    observer.observe({type:"longtask",buffered:false});
    state.cleanup=()=>{window.removeEventListener("mousemove",event,true);window.removeEventListener("wheel",event,true);observer.disconnect();};
    const tick=(t:number)=>{if(!state.running)return;if(state.previous)state.intervals.push(t-state.previous);state.previous=t;state.frames++;const gpu=w.rendererStatus?.().gpu;if(gpu?.canvasVisible)state.gpuFrames++;state.preparesDuring.push(gpu?.prepares||0);if(gpu?.moving)state.movingFrames++;state.cameras.push([(0,eval)("scale"),(0,eval)("viewX"),(0,eval)("viewY")]);requestAnimationFrame(tick);};
    requestAnimationFrame(tick);
   });
   if(gesture!=="wheel-zoom")await session.send("Input.dispatchMouseEvent",{type:"mousePressed",x:640,y:360,button:"left",buttons:1,clickCount:1});
   for(let frame=0;frame<120;frame++){
    if(gesture==="wheel-zoom")await session.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:640,y:360,deltaX:0,deltaY:frame<60?-8:8});
    else{const amount=gesture==="pan-near"?60:600;await session.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:640+amount*Math.sin(frame/120*Math.PI*4),y:360+60*Math.sin(frame/120*Math.PI*2),button:"left",buttons:1});}
    await new Promise(done=>setTimeout(done,8));
   }
   if(gesture!=="wheel-zoom")await session.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:640,y:360,button:"left",buttons:0,clickCount:1});
   const data=await page.evaluate(async()=>{await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));const s=(globalThis as any).__nativeNav;s.running=false;s.cleanup();delete s.cleanup;return s;});
   await page.waitForTimeout(800);
   await page.evaluate(async()=>{const w=globalThis as any;await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);});
   const status=await page.evaluate(()=>{const w=globalThis as any;return {renderer:w.rendererStatus?.(),cells:w.pack.cells.i.length,finalCameraExact:document.querySelector("#viewbox")?.getAttribute("transform")===`translate(${(0,eval)("viewX")} ${(0,eval)("viewY")}) scale(${(0,eval)("scale")})`};});
   runs.push({world,gesture,inputMethod:"cdp-input",injected:true,physicalInput:false,readyWaitMs,deviceScaleFactor:Number(process.env.SMOKE_DPR||1),frame:summarize(data.intervals),idleFrame:summarize(idle),eventToNextRaf:summarize(data.events),longTasks:summarize(data.tasks),gpuPresentedFraction:data.gpuFrames/data.frames,preparesDuringMotion:Math.max(...data.preparesDuring)-data.preparesAtStart,movingFrameFraction:data.movingFrames/data.frames,cameraChanged:new Set(data.cameras.map((v:number[])=>v.join(","))).size>1,...status});
   console.log(JSON.stringify(runs.at(-1)));
  }
 }
 (report as any).runs=runs;
 (report as any).requestedRenderer=arm;
 (report as any).limitations="Pilot only; injected CDP browser input, event timestamp to next requestAnimationFrame (not physical input-to-photon), not 10 interleaved pairs.";
 await session.detach();
} catch(e){report.failure=String(e);} finally {if(report.warnings.some(w=>/GL_INVALID_|Feedback loop/i.test(w)))report.failure??="WebGL validation warning; reject render/timing result";writeFileSync(output+".json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
