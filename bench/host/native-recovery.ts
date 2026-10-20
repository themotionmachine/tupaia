// Ported from the Codex host harness (control/overnight-native-recovery-20261019.ts). Run it through bench/gate/gate.ts, which holds the
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
  if(request.method!=="GET")return void response.writeHead(405).end();
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
 await context.addInitScript(({origin}) => {if(location.origin!==origin)return;localStorage.setItem("autosaveInterval","0");localStorage.setItem("azgaarAssistant","hide");},{origin});
 const scripts=["bridge.js","bridge-mutations.js",...readdirSync(resolve(root,"mcp/src/bridge-ext")).filter(n=>n.endsWith(".js")).sort().map(n=>"bridge-ext/"+n)];
 await context.addInitScript(scripts.map(n=>readFileSync(resolve(root,"mcp/src",n),"utf8")).join("\n"));
 await context.route("**/*",route=>(route.request().method()==="GET"&&new URL(route.request().url()).origin===origin)||(route.request().method()==="GET"&&new URL(route.request().url()).hostname==="fonts.gstatic.com")?route.continue():route.abort());
 (report as any).chargeRequestFailures=[];(report as any).chargeConsoleFailures=0;
 const page=await context.newPage();
 page.on("requestfailed",request=>{if(new URL(request.url()).pathname.startsWith("/charges/"))(report as any).chargeRequestFailures.push({url:new URL(request.url()).pathname,error:request.failure()?.errorText});});
 page.on("console",m=>{if(m.type()==="error"&&/fetchCharge|Cannot fetch charge/.test(m.text()))(report as any).chargeConsoleFailures++;});
page.setDefaultTimeout(90000);
 page.on("pageerror",e=>report.errors.push(e.message));page.on("console",m=>{if(["warning","error"].includes(m.type())&&report.warnings.length<50)report.warnings.push(m.text().slice(0,1000));});page.on("dialog",d=>d.dismiss());
 await page.goto(origin+"/?local&seed=7319&width=1280&height=720&renderer="+(process.env.NAV_RENDERER||"gpu"));
 await page.evaluate(async ({text,hideRelief})=>{const w=globalThis as any;const ready=await w.__tupaia.call("ready",{timeoutMs:120000});if(!ready.ok)throw Error(JSON.stringify(ready));await w.__tupaia.fns.loadMap({text,timeoutMs:120000});const shown=await w.__tupaia.call("display",hideRelief?{on:["heightmap"],off:["relief"]}:{on:["heightmap","relief"]});if(!shown.ok)throw Error(JSON.stringify(shown));await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);},{text:readFileSync(process.env.GATE_MAP||"/tmp/tupaia-navigation-shared-v8.map","utf8"),hideRelief:process.env.SMOKE_HIDE_RELIEF==="1"});

 if(process.env.NAV_LOADING_CHECK==="1"){
  await page.waitForFunction(()=>getComputedStyle(document.getElementById("loading")!).display==="none",{},{timeout:5000});
  (report as any).loadingChecks=await page.evaluate(async()=>{
   const w=globalThis as any,root=document.getElementById("loading")!,sleep=(ms:number)=>new Promise(done=>setTimeout(done,ms));
   const state=()=>({display:getComputedStyle(root).display,opacity:Number(getComputedStyle(root).opacity),animations:root.getAnimations({subtree:true}).filter(a=>a.playState==="running").length});
   const initial=state();w.showLoading();await sleep(300);const visible=state();w.hideLoading();await sleep(100);const fading=state();
   w.showLoading();await sleep(300);const interruptedHide=state();w.hideLoading();
   return {initial,visible,fading,interruptedHide,pass:initial.display==="none"&&initial.animations===0&&visible.display!=="none"&&visible.opacity===1&&visible.animations>0&&fading.display!=="none"&&fading.opacity>0&&interruptedHide.display!=="none"&&interruptedHide.opacity===1};
  });
  await page.waitForFunction(()=>getComputedStyle(document.getElementById("loading")!).display==="none",{},{timeout:4000});
  (report as any).loadingChecks.final=await page.evaluate(()=>{const r=document.getElementById("loading")!;return{display:getComputedStyle(r).display,animations:r.getAnimations({subtree:true}).filter(a=>a.playState==="running").length};});
  if(!(report as any).loadingChecks.pass||(report as any).loadingChecks.final.animations)throw Error("Loading lifecycle failed");
 }
 (report as any).contextProperties=await page.evaluate(()=>{const gl=(document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement)?.getContext("webgl2");const debug=gl?.getExtension("WEBGL_debug_renderer_info");return gl?{attributes:gl.getContextAttributes(),samples:gl.getParameter(gl.SAMPLES),adapter:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null}:null;});
 const arm=process.env.NAV_RENDERER||"gpu";
 const session=await context.newCDPSession(page);
 const summarize=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.floor(s.length*.5)]||0,p95:s[Math.min(s.length-1,Math.floor(s.length*.95))]||0,max:s.at(-1)||0};};
 const runs=[];
 for(const world of (process.env.NAV_WORLD?[process.env.NAV_WORLD]:["shared","100k"])){
  if(world==="100k")await page.evaluate(async()=>{const w=globalThis as any;await w.__tupaia.fns.generateMap({cells:100000,seed:"7319",template:"continents",width:1280,height:720});await w.__tupaia.call("display",{on:["heightmap","relief"]});await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);});
  await page.evaluate(async()=>{
   const w=globalThis as any;const shown=await w.__tupaia.call("display",{on:["emblems"]});if(!shown.ok)throw Error(JSON.stringify(shown));
   await w.__tupaia.settle();if(!document.querySelector("#emblems use")){w.drawEmblems();await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));}
   // Keep ordinary lazy COA behavior for actual moving context-loss proof.
   await w.__tupaia.settle();
  });
  const coaIdentity=await page.evaluate(async()=>{
   const definitions=[...document.querySelectorAll("#coas > svg")].sort((a,b)=>a.id.localeCompare(b.id));
   const text=definitions.map(e=>e.outerHTML).join("");
   const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
   return {sha256:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join(""),bytes:text.length,definitions:definitions.length,uses:document.querySelectorAll("#emblems use").length};
  });
  if((report as any).chargeRequestFailures.length||(report as any).chargeConsoleFailures)throw Error("Incomplete COA assets; reject timing");
  for(const gesture of (process.env.NAV_GESTURE?[process.env.NAV_GESTURE]:["pan-near","pan-wide","wheel-zoom"])){
   const k=gesture==="wheel-zoom"?3.5:8;
   await page.evaluate(k=>{const w=globalThis as any;w.d3.select("#map").call((0,eval)("zoom").transform,w.d3.zoomIdentity.translate(640-w.graphWidth*k/2,360-w.graphHeight*k/2).scale(k));},k);
   const readyStart=Date.now();
   await page.evaluate(async()=>{const w=globalThis as any;await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);});
   if(arm==="gpu")await page.waitForFunction(()=>{const s=(globalThis as any).rendererStatus?.();return s?.active==="gpu"&&s.gpu?.canvasVisible&&!s.gpu.pending&&!s.gpu.refinementPending;},{},{timeout:30000});
   const readyWaitMs=Date.now()-readyStart;
   const cullingBefore=await page.evaluate(disabled=>{
    const w=globalThis as any,r=w.gpuRenderer;
    w.__nativeCulling=r?.emblemCulling;
    if(disabled&&r?.emblemCulling){r.emblemCulling.update(r.view,r.viewport,false);r.emblemCulling=null;}
    return w.__nativeCulling?.status?.()??null;
   },process.env.NAV_CULLING==="off");
   if(process.env.NAV_CULLING==="off"&&cullingBefore?.hidden)throw Error("Uncull baseline contaminated");
   const idle=await page.evaluate(()=>new Promise<number[]>(resolve=>{const times:number[]=[];let previous=0;const tick=(t:number)=>{if(previous)times.push(t-previous);previous=t;if(times.length<120)requestAnimationFrame(tick);else resolve(times)};requestAnimationFrame(tick);}));
   await page.evaluate(()=>{
    const w=globalThis as any;
    const state: any=w.__nativeNav={running:true,intervals:[] as number[],events:[] as number[],tasks:[] as number[],paintFrames:0,paintEligibleFrames:0,gpuFrames:0,frames:0,previous:0,preparesAtStart:w.rendererStatus?.().gpu?.prepares||0,preparesDuring:[] as number[],movingFrames:0,cameras:[] as number[][]};
    const event=(e:Event)=>{const stamp=e.timeStamp;requestAnimationFrame(()=>state.events.push(performance.now()-stamp));};
    window.addEventListener("mousemove",event,true);window.addEventListener("wheel",event,true);
    const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())state.tasks.push(e.duration)});
    observer.observe({type:"longtask",buffered:false});
    state.cleanup=()=>{window.removeEventListener("mousemove",event,true);window.removeEventListener("wheel",event,true);observer.disconnect();};
    const tick=(t:number)=>{if(!state.running)return;if(state.previous)state.intervals.push(t-state.previous);state.previous=t;state.frames++;const gpu=w.rendererStatus?.().gpu;if(gpu?.canvasVisible)state.gpuFrames++;const paint=w.gpuRenderer?.emblemCulling?.status?.();if(paint?.paintSuppressed)state.paintFrames++;if(paint?.paintEligible)state.paintEligibleFrames++;state.preparesDuring.push(gpu?.prepares||0);if(gpu?.moving)state.movingFrames++;state.cameras.push([(0,eval)("scale"),(0,eval)("viewX"),(0,eval)("viewY")]);requestAnimationFrame(tick);};
    requestAnimationFrame(tick);
   });
   if(gesture!=="wheel-zoom")await session.send("Input.dispatchMouseEvent",{type:"mousePressed",x:640,y:360,button:"left",buttons:1,clickCount:1});
   let traceDone:Promise<any>|null=null;
   if(process.env.NAV_TRACE==="1"){
    traceDone=new Promise(done=>session.once("Tracing.tracingComplete",done));
    await session.send("Profiler.enable");await session.send("Profiler.setSamplingInterval",{interval:1000});await session.send("Profiler.start");
    await session.send("Tracing.start",{categories:"devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,cc",transferMode:"ReturnAsStream"});
   }
   for(let frame=0;frame<120;frame++){
    if(gesture==="wheel-zoom")await session.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:640,y:360,deltaX:0,deltaY:frame<60?-8:8});
    else{const amount=gesture==="pan-near"?60:600;await session.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:640+amount*Math.sin(frame/120*Math.PI*4),y:360+60*Math.sin(frame/120*Math.PI*2),button:"left",buttons:1});}

    if(frame===20){
     const proof=await page.evaluate(()=>{
      const w=globalThis as any,manager=w.gpuRenderer?.emblemCulling,paint=manager?.paint;
      if(!paint?.active)throw Error("Product paint suppression not active during real wheel input");
      const layer=document.querySelector("#map #emblems")!,map=document.getElementById("map")!,canvas=document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement;
      const svgBefore=map.outerHTML,pixelsBefore=canvas.toDataURL();
      const samples:{x:number,y:number,hit:Element|null}[]=[];
      for(const use of layer.querySelectorAll("use")){
       const r=use.getBoundingClientRect();if(!r.width||!r.height||r.right<0||r.bottom<0||r.left>1280||r.top>720)continue;
       for(let iy=0;iy<9;iy++)for(let ix=0;ix<9;ix++){const x=r.left+r.width*(ix-.5)/7,y=r.top+r.height*(iy-.5)/7;if(x<0||x>=1280||y<0||y>=720)continue;samples.push({x,y,hit:document.elementFromPoint(x,y)});}
       if(samples.length>=4000)break;
      }
      const emblemHits=samples.filter(p=>p.hit?.closest("#emblems")).length;
      let canonicalVisibility="",mismatches=0;
      try{
       paint.set(false);canonicalVisibility=getComputedStyle(layer).visibility;
       mismatches=samples.filter(p=>document.elementFromPoint(p.x,p.y)!==p.hit).length;
      }finally{paint.set(true);}
      const restoredMismatches=samples.filter(p=>document.elementFromPoint(p.x,p.y)!==p.hit).length;
      const result={samples:samples.length,emblemHits,mismatches,restoredMismatches,canonicalVisibility,restoredVisibility:getComputedStyle(layer).visibility,ownRuleActive:paint.active,svgMarkupExact:svgBefore===map.outerHTML,gpuCanvasExact:pixelsBefore===canvas.toDataURL(),moving:w.rendererStatus?.().gpu?.moving};
      const ext=canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context");
      if(!ext)throw Error("Context-loss extension unavailable");
      w.__movingLossExt=ext;ext.loseContext();return result;
     });
     (report as any).movingProof=proof;
     if(!proof.samples||!proof.emblemHits||proof.mismatches||proof.restoredMismatches||proof.canonicalVisibility!=="visible"||proof.restoredVisibility!=="hidden"||!proof.ownRuleActive||!proof.svgMarkupExact||!proof.gpuCanvasExact)throw Error("Product moving native parity failed "+JSON.stringify(proof));
     await page.waitForFunction(()=>(globalThis as any).rendererStatus?.().gpu?.state==="lost",{},{timeout:15000});
     const lost=await page.evaluate(()=>{const w=globalThis as any;return{state:w.rendererStatus?.().gpu?.state,canvasVisible:w.rendererStatus?.().gpu?.canvasVisible,visibility:getComputedStyle(document.querySelector("#map #emblems")!).visibility,culled:document.querySelectorAll("#map #emblems use.viewport-culled").length,paint:w.gpuRenderer?.emblemCulling?.status?.()};});
     if(lost.state!=="lost"||lost.canvasVisible||lost.visibility!=="visible"||lost.culled||lost.paint?.paintSuppressed)throw Error("Moving context loss did not reveal canonical SVG "+JSON.stringify(lost));
     await session.send("Profiler.enable");await session.send("Profiler.setSamplingInterval",{interval:500});await session.send("Performance.enable");
     const recoveryMetricsBefore=await session.send("Performance.getMetrics"),recoveryStarted=Date.now();
     await session.send("Profiler.start");
     await page.evaluate(()=>{const w=globalThis as any;w.__movingLossExt.restoreContext();delete w.__movingLossExt;});
     await page.waitForFunction(()=>{const s=(globalThis as any).rendererStatus?.();return s?.active==="gpu"&&s.gpu?.canvasVisible&&!s.gpu.pending&&!s.gpu.refinementPending;},{},{timeout:30000});
     const restored=await page.evaluate(()=>{const w=globalThis as any;return{state:w.rendererStatus?.().gpu?.state,restoreMs:w.rendererStatus?.().gpu?.lastRestoreMs,visibility:getComputedStyle(document.querySelector("#map #emblems")!).visibility,paint:w.gpuRenderer?.emblemCulling?.status?.()};});
     const recoveryProfile=await session.send("Profiler.stop");
     writeFileSync(output+".recovery.cpuprofile",JSON.stringify(recoveryProfile.profile),{flag:"wx"});
     (report as any).recoveryProfile={wallMs:Date.now()-recoveryStarted,before:recoveryMetricsBefore,after:await session.send("Performance.getMetrics"),
       status:await page.evaluate(()=>{const g=(globalThis as any).rendererStatus?.().gpu;return {restore:g?.restore,lastPrepare:g?.lastPrepare,lastPrepareMs:g?.lastPrepareMs};})};
     (report as any).movingContextLoss={injectedWhileMovingAndPaintSuppressed:true,lost,restored};
     break;

    }
    await new Promise(done=>setTimeout(done,8));
   }
   if(gesture!=="wheel-zoom")await session.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:640,y:360,button:"left",buttons:0,clickCount:1});
   const data=await page.evaluate(async()=>{await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));const s=(globalThis as any).__nativeNav;s.running=false;s.cleanup();delete s.cleanup;return s;});
   if(traceDone){
    const profile=await session.send("Profiler.stop");writeFileSync(output+"-"+world+"-"+gesture+".cpuprofile",JSON.stringify(profile.profile),{flag:"wx"});
    await session.send("Tracing.end");const complete=await traceDone;let first=true;
    while(true){const part=await session.send("IO.read",{handle:complete.stream});writeFileSync(output+"-"+world+"-"+gesture+".trace.json",part.base64Encoded?Buffer.from(part.data,"base64"):part.data,{flag:first?"wx":"a"});first=false;if(part.eof)break;}
    await session.send("IO.close",{handle:complete.stream});
   }
   await page.waitForTimeout(800);
   await page.evaluate(async()=>{const w=globalThis as any;await w.__tupaia.settle();await Promise.all([w.reliefRenderReady,w.burgRenderReady]);});
   const status=await page.evaluate(()=>{const w=globalThis as any;let hash=2166136261;for(const field of ["h","biome","state","culture","burg","r"])for(const value of w.pack.cells[field]||[])hash=Math.imul(hash^value,16777619);return {worldDigest:hash>>>0,canonicalEmblems:w.__nativeCulling?.status?.(),emblemUses:document.querySelectorAll("#emblems use").length,emblemDefinitions:document.querySelectorAll("#coas > svg").length,renderer:w.rendererStatus?.(),cells:w.pack.cells.i.length,finalCameraExact:document.querySelector("#viewbox")?.getAttribute("transform")===`translate(${(0,eval)("viewX")} ${(0,eval)("viewY")}) scale(${(0,eval)("scale")})`};});
   runs.push({world,gesture,coaIdentity,cullingBefore,cullingMode:process.env.NAV_CULLING||"on",inputMethod:"cdp-input",injected:true,physicalInput:false,readyWaitMs,deviceScaleFactor:Number(process.env.SMOKE_DPR||1),frame:summarize(data.intervals),idleFrame:summarize(idle),eventToNextRaf:summarize(data.events),longTasks:summarize(data.tasks),paintSuppressedFraction:data.paintFrames/data.frames,paintEligibleFraction:data.paintEligibleFrames/data.frames,gpuPresentedFraction:data.gpuFrames/data.frames,preparesDuringMotion:Math.max(...data.preparesDuring)-data.preparesAtStart,movingFrameFraction:data.movingFrames/data.frames,cameraChanged:new Set(data.cameras.map((v:number[])=>v.join(","))).size>1,...status});
   console.log(JSON.stringify(runs.at(-1)));
   await page.evaluate(()=>{const w=globalThis as any;if(w.__nativeCulling){w.gpuRenderer.emblemCulling=w.__nativeCulling;w.gpuRenderer.emblemCulling.update(w.gpuRenderer.view,w.gpuRenderer.viewport,true);}delete w.__nativeCulling;});
  }
 }
 (report as any).runs=runs;
 if((report as any).chargeRequestFailures.length||(report as any).chargeConsoleFailures)throw Error("Incomplete COA assets; reject timing");

 (report as any).requestedRenderer=arm;
 (report as any).diagnosticTimingsInvalid=true;
 (report as any).limitations="Correctness diagnostic interrupts native input with thousands of hit tests; DO NOT use timings. Pilot only; injected CDP browser input, event timestamp to next requestAnimationFrame (not physical input-to-photon), not 10 interleaved pairs.";
 await session.detach();
} catch(e){report.failure=String(e);} finally {if(report.warnings.some(w=>/GL_INVALID_|Feedback loop/i.test(w)))report.failure??="WebGL validation warning; reject render/timing result";writeFileSync(output+".json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
