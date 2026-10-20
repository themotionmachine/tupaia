// Ported from the Codex host harness (control/gpu-smoke.ts). Run it through bench/gate/gate.ts, which holds the
// host lock and sets GATE_OUT_DIR (evidence directory) and GATE_MAP (shared-v8 fixture). See docs/performance/webgl-rewrite/GATE.md.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { isolateLayer } from "./golden-isolation.ts";
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
const report = {diagnosticGroupSamples:process.env.SMOKE_GROUP_SAMPLES?Number(process.env.SMOKE_GROUP_SAMPLES):null,diagnosticIsolatedLayer:process.env.SMOKE_ONLY_LAYER||null,diagnosticNoMsaa:process.env.SMOKE_NO_MSAA==="1",diagnosticOpaqueCanvas:process.env.SMOKE_OPAQUE_CANVAS==="1",diagnosticHiddenRelief:process.env.SMOKE_HIDE_RELIEF==="1",runStartedUtc:new Date().toISOString(),errors:[] as string[], warnings:[] as string[], failure:null as string | null, status:null as unknown, diff:null as unknown, animation:null as unknown};
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
 // Diagnostic isolation, shared with the per-layer golden (golden-isolation.ts): hides the other #viewbox layers and the
 // root overlays, white backdrop as the svg background (no extra element in the GPU scene).
 if(process.env.SMOKE_ONLY_LAYER)await page.evaluate(isolateLayer,{id:process.env.SMOKE_ONLY_LAYER,bg:"#ffffff"});
 (report as any).contextProperties=await page.evaluate(()=>{const gl=(document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement)?.getContext("webgl2");return gl?{attributes:gl.getContextAttributes(),samples:gl.getParameter(gl.SAMPLES)}:null;});
 if(process.env.SMOKE_ZOOM) await page.evaluate(async k=>{const w=globalThis as any;w.d3.select("#map").call((0,eval)("zoom").transform,w.d3.zoomIdentity.translate(640-w.graphWidth*k/2,360-w.graphHeight*k/2).scale(k));await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);},Number(process.env.SMOKE_ZOOM));
 try {await page.waitForFunction(()=>{const s=(globalThis as any).rendererStatus?.();const c=document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;if(s?.active==="svg"&&s?.fallbackReason)return true;return s?.gpu?.state==="active"&&!s.gpu.pending&&!!c&&getComputedStyle(c).display!=="none";},{},{timeout:15000});}
 catch(e){report.failure=String(e);}
 report.status=await page.evaluate(()=>({...(globalThis as any).rendererStatus?.(),temporaryExportClones:document.querySelectorAll("#fantasyMap").length}));
 if((report.status as any)?.active!=="gpu")report.failure="GPU fallback: "+(report.status as any)?.fallbackReason;
 if((report.status as any)?.gpu?.canvasVisible){
  // Live trade markers are D3 groups in the hidden SVG; the GPU mirrors them per frame. Sample poses, GPU frame counter and both
  // marker counts (DOM <use> in visible groups vs rendererStatus().gpu.markers) around a wait, then assert (TRADE packet).
  const sample=()=>page.evaluate(()=>new Promise<any>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const groups=[...document.querySelectorAll("#tradeAnimation > g")] as Element[];
    const shown=groups.filter(g=>g.getAttribute("display")!=="none");
    resolve({poses:groups.map(e=>e.getAttribute("transform")),domMarkers:shown.reduce((n,g)=>n+g.querySelectorAll(":scope > use").length,0),frames:(globalThis as any).rendererStatus?.().gpu?.frames||0,gpuMarkers:(globalThis as any).rendererStatus?.().gpu?.markers??null,tradeOn:!!(globalThis as any).layerIsOn?.("toggleTrade")});
  }))));
  const before=await sample();
  await page.waitForTimeout(150);
  const after=await sample();
  // Counts are compared within one sample (same rAF turn); spawns/removals between the DOM read and the last GPU frame are retried.
  const countSamples=[after];
  for(let i=0;i<6&&countSamples.at(-1).gpuMarkers!==countSamples.at(-1).domMarkers;i++){await page.waitForTimeout(60);countSamples.push(await sample());}
  const counted=countSamples.at(-1);
  const markerCount=after.poses.length;
  const animation:any={tradeLayerOn:after.tradeOn,markerCount,domMarkers:counted.domMarkers,gpuMarkers:counted.gpuMarkers,countSamples:countSamples.length,moved:JSON.stringify(before.poses)!==JSON.stringify(after.poses),gpuFrameAdvance:after.frames-before.frames,frozenForFidelity:true,failures:[] as string[]};
  if(markerCount===0)animation.skipped="no live trade markers in the fixture (nothing to assert)";
  else{
    if(!animation.moved)animation.failures.push("markers present but no pose changed in 150 ms");
    if(animation.gpuFrameAdvance<=0)animation.failures.push("GPU frame counter did not advance while markers animated");
    if(animation.gpuMarkers!==animation.domMarkers)animation.failures.push(`gpu.markers ${animation.gpuMarkers} != DOM markers ${animation.domMarkers}`);
    if(!(animation.gpuMarkers>0))animation.failures.push("GPU mirrored no markers");
  }
  report.animation=animation;
  await page.evaluate(()=>{(globalThis as any).d3.select("#tradeAnimation").selectAll("*").interrupt();return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  // World positions of up to 3 distinct frozen markers (land first, then water) for the zoomed pixel check below.
  (report as any).markerTargets=await page.evaluate(()=>{const seen=new Set<string>(),out:any[]=[];for(const g of [...document.querySelectorAll("#tradeAnimation > g:not([display=none])")] as Element[]){const u=g.querySelector(":scope > use"),m=/translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)\s*\)/.exec(g.getAttribute("transform")||"");if(!u||!m)continue;const key=(u.getAttribute("href")||"")+Math.round(Number(m[1]))+","+Math.round(Number(m[2]));if(seen.has(key))continue;seen.add(key);out.push({kind:u.getAttribute("href"),x:Number(m[1]),y:Number(m[2])});}
    const water=out.filter(t=>/water/.test(t.kind)),land=out.filter(t=>/land/.test(t.kind));return [...land.slice(0,2),...water.slice(0,1),...land.slice(2),...water.slice(1)].slice(0,3);});
 }

 (report as any).reliefReference=await page.evaluate(async()=>({camera:{k:(0,eval)("scale"),x:(0,eval)("viewX"),y:(0,eval)("viewY")},images:await Promise.all([...document.querySelectorAll("#terrain image")].map(async(e:any)=>{const src=e.getAttribute("href");const image=new Image();if(src){image.src=src;try{await image.decode();}catch{}}return {attributes:e.getAttributeNames().filter((n:string)=>n!=="href"&&n!=="data-relief"),worldWidth:e.getAttribute("width"),worldHeight:e.getAttribute("height"),naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,hidden:e.hasAttribute("data-zoom-hidden"),dense:e.hasAttribute("data-relief-viewport")};}))}));
 (report as any).labelStyles=await page.evaluate(()=>[...document.querySelectorAll("#labels text:has(textPath) tspan")].slice(0,20).map(e=>{const s=getComputedStyle(e);return {id:e.parentElement?.parentElement?.id,dominantBaseline:s.dominantBaseline,alignmentBaseline:s.alignmentBaseline,baselineShift:s.baselineShift,letterSpacing:s.letterSpacing};}));
 (report as any).initialPresentation=report.status;
 await page.screenshot({path:output+"-initial-gpu.png",animations:"disabled"});
 const sharpStart=Date.now();
 await page.waitForFunction(()=>{const s=(globalThis as any).rendererStatus?.();return s?.active!=="gpu"||(!s.gpu?.pending&&!s.gpu?.refinementPending);},{},{timeout:30000});
 (report as any).refinementWaitMs=Date.now()-sharpStart;
 report.status=await page.evaluate(()=>(globalThis as any).rendererStatus?.());
 if(process.env.SMOKE_GROUP_SAMPLES){
  (report as any).groupSampling=await page.evaluate(async samples=>{
    const r=(globalThis as any).gpuRenderer,device=r.device,graph=r.graph,original=device.target;
    device.target=function(label:string,width:number,height:number){return original.call(this,label,width,height,samples);};
    device.release(graph.group);graph.group=null;r.requestDraw();
    await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
    const target=graph.group,gl=device.gl;
    gl.bindRenderbuffer(gl.RENDERBUFFER,target.color||target.depthStencil);
    const driverReportedSamples=gl.getRenderbufferParameter(gl.RENDERBUFFER,gl.RENDERBUFFER_SAMPLES);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);
    return {requested:samples,tracked:target.samples,driverReportedSamples};
  },Number(process.env.SMOKE_GROUP_SAMPLES));
  report.status=await page.evaluate(()=>(globalThis as any).rendererStatus?.());
 }
 const gpu=await page.screenshot({path:output+"-gpu.png",animations:"disabled"});
 const old=await page.evaluate(()=>{const c=document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;if(!c)return null;const old=c.style.visibility;c.style.visibility="hidden";return old;});
 const svg=await page.screenshot({path:output+"-svg.png",animations:"disabled"});
 await page.evaluate(old=>{const c=document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;if(c)c.style.visibility=old||"";},old);
 report.diff=await page.evaluate(async images=>{const pixels=[];for(const data of images){const i=new Image();i.src="data:image/png;base64,"+data;await i.decode();const c=document.createElement("canvas");c.width=i.width;c.height=i.height;const x=c.getContext("2d")!;x.drawImage(i,0,0);pixels.push(x.getImageData(0,0,c.width,c.height));}const [a,b]=pixels;let changed=0,over16=0,max=0,sum=0;for(let p=0;p<a.data.length;p+=4){let delta=0;for(let j=0;j<3;j++)delta=Math.max(delta,Math.abs(a.data[p+j]-b.data[p+j]));if(delta)changed++;if(delta>16)over16++;max=Math.max(max,delta);sum+=delta;}return {width:a.width,height:a.height,changedFraction:changed/(a.width*a.height),over16Fraction:over16/(a.width*a.height),maxDelta:max,meanMaxChannelDelta:sum/(a.width*a.height)};},[gpu.toString("base64"),svg.toString("base64")]);

 // Marker-crop pixel check (TRADE). The camera is zoomed onto each frozen marker so it spans tens of pixels. "Ink" = pixels differing >16 from the
 // same arm with the trade layer hidden (SVG vs SVG, GPU vs GPU, so map-wide GPU/SVG differences are not ink). The GPU ink mask must overlap the SVG
 // ink mask (IoU), so a missing, misplaced or wrongly sized marker cannot hide in a clean crop. Runs last: it moves the camera.
 const targets=((report as any).markerTargets||[]) as {kind:string,x:number,y:number}[];
 if(targets.length&&report.animation&&!report.failure){
  const anim=report.animation as any;
  const k=Number(process.env.SMOKE_MARKER_ZOOM||14);
  const gpuSettled=()=>page.waitForFunction(()=>{const s=(globalThis as any).rendererStatus?.();return s?.active!=="gpu"||(s.gpu?.canvasVisible&&!s.gpu?.pending&&!s.gpu?.refinementPending);},{},{timeout:30000});
  const shot=async(clip:any)=>(await page.screenshot({clip,animations:"disabled"})).toString("base64");
  const masks=(images:string[])=>page.evaluate(async images=>{const px=[];let w=0;for(const data of images){const i=new Image();i.src="data:image/png;base64,"+data;await i.decode();const c=document.createElement("canvas");w=c.width=i.width;c.height=i.height;const x=c.getContext("2d")!;x.drawImage(i,0,0);px.push(x.getImageData(0,0,c.width,c.height).data);}
    const ink=(a:Uint8ClampedArray,b:Uint8ClampedArray)=>{const m=new Uint8Array(a.length/4);for(let p=0;p<a.length;p+=4)if(Math.max(Math.abs(a[p]-b[p]),Math.abs(a[p+1]-b[p+1]),Math.abs(a[p+2]-b[p+2]))>16)m[p/4]=1;return m;};
    const [g,s,sb,gb]=px,mg=ink(g,gb),ms=ink(s,sb);let both=0,either=0,gn=0,sn=0;for(let i=0;i<mg.length;i++){gn+=mg[i];sn+=ms[i];both+=mg[i]&ms[i];either+=mg[i]|ms[i];}
    let rawDiff=0;for(let p=0;p<g.length;p+=4)if(Math.max(Math.abs(g[p]-s[p]),Math.abs(g[p+1]-s[p+1]),Math.abs(g[p+2]-s[p+2]))>16)rawDiff++;
    return {pixels:g.length/4,width:w,gpuInk:gn,svgInk:sn,iou:either?both/either:null,inkRatio:sn?gn/sn:null,rawGpuVsSvgFraction:rawDiff/(g.length/4)};},images);
  const results:any[]=[];
  for(const t of targets){
    await page.evaluate(async({x,y,k})=>{const w=globalThis as any;w.d3.select("#map").call((0,eval)("zoom").transform,w.d3.zoomIdentity.translate(640-x*k,360-y*k).scale(k));await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);},{x:t.x,y:t.y,k});
    await page.waitForTimeout(100);await gpuSettled();
    const clip={x:640-48,y:360-48,width:96,height:96};
    const gpuShot=await shot(clip);
    await page.evaluate(()=>{(document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement).style.visibility="hidden";});
    const svgShot=await shot(clip);
    await page.evaluate(()=>{(document.querySelector("#tradeAnimation") as SVGElement).style.display="none";});
    const svgBare=await shot(clip);
    await page.evaluate(()=>{(document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement).style.visibility="";});
    await page.waitForTimeout(100);await gpuSettled();
    const gpuBare=await shot(clip);
    await page.evaluate(()=>{(document.querySelector("#tradeAnimation") as SVGElement).style.removeProperty("display");});
    await page.waitForTimeout(100);await gpuSettled();
    results.push({target:t,zoom:k,...(await masks([gpuShot,svgShot,svgBare,gpuBare]))});
  }
  const th={minSvgInkPixels:200,minIou:Number(process.env.SMOKE_MARKER_MIN_IOU||0.6),inkRatio:[0.6,1.6]};
  anim.pixelCheck={cropCount:results.length,minIou:Math.min(...results.map(r=>r.iou??0)),threshold:th,crops:results};
  const bad=results.filter(r=>r.svgInk<th.minSvgInkPixels||(r.iou??0)<th.minIou||(r.inkRatio??0)<th.inkRatio[0]||(r.inkRatio??0)>th.inkRatio[1]);
  if(bad.length)anim.failures.push(`${bad.length}/${results.length} zoomed marker crops disagree SVG vs GPU (iou<${th.minIou}, ink ratio outside ${th.inkRatio.join("..")}, or SVG shows <${th.minSvgInkPixels} ink px)`);
 }
 if(report.animation&&(report.animation as any).failures?.length)report.failure??="trade animation: "+(report.animation as any).failures.join("; ");

 if(process.env.SMOKE_LIFECYCLE==="1" || process.env.SMOKE_CONTEXT==="1") {
   const cdp=await context.newCDPSession(page);
   await cdp.send("Performance.enable");
   const snapshots=[];
   for(let cycle=0;cycle<=(process.env.SMOKE_LIFECYCLE==="1"?20:0);cycle++){
     if(cycle) await page.evaluate(async text=>{const w=globalThis as any;await w.__tupaia.fns.loadMap({text,timeoutMs:120000});await w.__tupaia.call("display",{on:["heightmap","relief"]});await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);},readFileSync(process.env.GATE_MAP||"/tmp/tupaia-navigation-shared-v8.map","utf8"));
     await page.waitForFunction(()=>{const s=(globalThis as any).rendererStatus?.();return s?.active==="gpu"&&s.gpu?.canvasVisible&&!s.gpu.pending&&!s.gpu.refinementPending;},{},{timeout:30000});
     await cdp.send("HeapProfiler.collectGarbage");
     const metrics=await cdp.send("Performance.getMetrics");
     snapshots.push({cycle,heapBytes:metrics.metrics.find(m=>m.name==="JSHeapUsedSize")?.value,status:await page.evaluate(()=>(globalThis as any).rendererStatus?.().gpu)});
   }
   (report as any).lifecycle={forcedGc:true,snapshots,heapGrowthBytes:snapshots.at(-1)!.heapBytes!-snapshots[0].heapBytes!};
   const available=await page.evaluate(()=>!!(document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement)?.getContext("webgl2")?.getExtension("WEBGL_lose_context"));
   if(available){
     await page.evaluate(()=>{const c=document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement;const ext=c.getContext("webgl2")!.getExtension("WEBGL_lose_context")!;(globalThis as any).__benchLoseContext=ext;ext.loseContext();});
     await page.waitForFunction(()=>(globalThis as any).rendererStatus?.().gpu?.state==="lost");
     const fallback=await page.evaluate(()=>(globalThis as any).rendererStatus?.().gpu);
     (report as any).contextRestore={supported:true,lost:fallback,restored:null,injectedLossAndRestore:true};
     await page.waitForTimeout(50);
     await page.evaluate(()=>{const c=document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement;(globalThis as any).__benchLoseContext.restoreContext();delete (globalThis as any).__benchLoseContext;});
     await page.waitForFunction(()=>{const s=(globalThis as any).rendererStatus?.();return s?.active==="gpu"&&s.gpu?.canvasVisible&&!s.gpu.pending;},{},{timeout:30000});
     (report as any).contextRestore={supported:true,lost:fallback,restored:await page.evaluate(()=>(globalThis as any).rendererStatus?.().gpu),injectedLossAndRestore:true};
   }else (report as any).contextRestore={supported:false};
   await cdp.detach();
 }
} catch(e){report.failure=String(e);} finally {if(report.warnings.some(w=>/GL_INVALID_|Feedback loop/i.test(w)))report.failure??="WebGL validation warning; reject render/timing result";writeFileSync(output+".json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
