import { chromium } from "playwright";
import { build } from "vite";
import { resolve } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
const output=process.env.COMPAT_BATCH_OUTPUT!;
if(!output||existsSync(output))throw Error("Unique output required");
const bundled=await build({configFile:false,logLevel:"silent",build:{write:false,minify:false,lib:{entry:resolve("bench/direct-compat-batch-entry.ts"),formats:["iife"],name:"__batchModule"}}});
const bundle=Array.isArray(bundled)?bundled[0]:bundled;
const code=(bundle as any).output.find((entry:any)=>entry.type==="chunk").code;

const browser=await chromium.launch({headless:true});
let result:unknown;
try{
 const context=await browser.newContext({serviceWorkers:"block"});await context.route("**/*",r=>r.abort());
 const page=await context.newPage();await page.addScriptTag({content:code});
 result=await page.evaluate(()=>{
  const api=(window as any).__batchAPI,ns="http://www.w3.org/2000/svg";
  const style=document.createElement("style");style.textContent=".viewport-culled{display:none!important;pointer-events:none!important}";document.head.append(style);
  const root=document.createElementNS(ns,"svg");root.id="map";root.setAttribute("width","100");root.setAttribute("height","100");root.style.overflow="hidden";
  root.innerHTML='<defs><g id="coas"></g></defs><g id="viewbox"><g id="emblems"><g id="burgEmblems"></g></g></g>';document.body.append(root);
  const defs=root.querySelector("#coas")!,group=root.querySelector("#burgEmblems")!,viewbox=root.querySelector("#viewbox")!;
  for(let i=0;i<24;i++){
   const asset=document.createElementNS(ns,"svg");asset.id="burgCOA"+i;asset.setAttribute("viewBox","0 0 20 20");asset.style.overflow="hidden";asset.innerHTML='<rect width="20" height="20" fill="red"/>';defs.append(asset);
   const use=document.createElementNS(ns,"use");use.id="emblem"+i;use.setAttribute("href","#burgCOA"+i);use.setAttribute("x",String(i*100));use.setAttribute("y","0");use.setAttribute("width","20");use.setAttribute("height","20");if(i%2)use.setAttribute("class","selected");group.append(use);
  }
  const canvas=document.createElement("canvas"),bounds=root.getBoundingClientRect();canvas.width=100;canvas.height=100;Object.assign(canvas.style,{position:"fixed",left:bounds.left+"px",top:bounds.top+"px",width:"100px",height:"100px",display:"block"});document.body.append(canvas);
  const manager=new api.HiddenEmblemCulling(()=>root,canvas),camera={k:1,x:0,y:0},viewport={width:100,height:100,dpr:1};
  const uses=[...group.children],assertions:Record<string,boolean>={};
  manager.reveal();const canonical=uses.map(use=>api.compatShapes(use,viewbox));manager.update(camera,viewport,true);
  const before=root.outerHTML;assertions.realOwnedCulls=manager.status().hidden>10;
  const actual=api.compatShapesBatch(uses,viewbox);assertions.geometryExact=JSON.stringify(actual)===JSON.stringify(canonical);
  assertions.everyRootPresent=actual.length===24&&actual.every((shapes:any[])=>shapes.length===1);
  assertions.sourceExact=root.outerHTML===before;
  assertions.overlappingRootsExact=JSON.stringify(api.compatShapesBatch([group,uses[0]],viewbox))===JSON.stringify([canonical.flat(),canonical[0]]);
  assertions.overlappingSourceExact=root.outerHTML===before;
  const failed=uses[10] as any,original=failed.getBBox;failed.getBBox=()=>{throw Error("native geometry injected");};
  let threw=false;try{api.compatShapesBatch(uses,viewbox);}catch(error){threw=String(error).includes("native geometry injected");}finally{failed.getBBox=original;}
  assertions.throwPropagates=threw;assertions.throwRestoresAllExact=root.outerHTML===before;
  manager.update(camera,viewport,true,true);const moving=root.outerHTML,paint=manager.status().paintSuppressed;
  const movingShapes=api.compatShapesBatch(uses,viewbox);
  assertions.movingPaintActive=paint;assertions.movingCanonicalGeometryExact=JSON.stringify(movingShapes)===JSON.stringify(canonical);
  assertions.movingPaintRestored=manager.status().paintSuppressed;assertions.movingSourceExact=root.outerHTML===moving;
  manager.dispose();assertions.disposeReveals=uses.every(use=>!use.classList.contains("viewport-culled"))&&getComputedStyle(group).visibility==="visible";
  return {assertions,pass:Object.values(assertions).every(Boolean),scope:"Actual SVG use shadow-tree geometry, separate and overlapping roots, exact restoration and moving-paint ownership"};
 });
}finally{await browser.close();}
writeFileSync(output,JSON.stringify(result,null,2),{flag:"wx"});console.log(JSON.stringify(result));if(!(result as any).pass)process.exitCode=1;
