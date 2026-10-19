// Source-backed browser contract probe, not the end-to-end suite. Synthetic fixtures isolate CSS and SVG export semantics.
import { chromium } from "playwright";
import ts from "typescript";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const output=process.env.EMBLEM_PROBE_OUTPUT!;
if(!output || existsSync(output)) throw new Error("Unique EMBLEM_PROBE_OUTPUT required");
const source=readFileSync("src/renderers/emblems/styles.ts","utf8");
const compatSource=readFileSync("src/gpu/compat.ts","utf8");
const isolateSource=compatSource.slice(compatSource.indexOf("export function isolate("),compatSource.indexOf("function decode("));
const isolateJs=ts.transpileModule(isolateSource.replace(/\bexport /g,""),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const js=ts.transpileModule(source.replace(/\bexport /g,""),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({serviceWorkers:"block"});
const blocked:string[]=[];
await context.route("**/*",r=>{blocked.push(r.request().url());return r.abort();});
const page=await context.newPage();
await page.addScriptTag({content:"(()=>{"+js+isolateJs+";window.__emblem={EMBLEM_RULES,maintainEmblemStyles,compactEmblemCloneStyles,isolate};})();"});
const result=await page.evaluate(async()=>{
 const {EMBLEM_RULES,maintainEmblemStyles,compactEmblemCloneStyles,isolate}=(window as any).__emblem;
 const ns="http://www.w3.org/2000/svg", make=(name:string)=>document.createElementNS(ns,name);
 const root=make("svg");root.id="coas";document.body.append(root);
 const makeCoa=(i:number)=>{
  const coa=make("svg");coa.id="burgCOA"+i;coa.setAttribute("viewBox","0 0 40 20");
  coa.innerHTML='<defs><style>'+EMBLEM_RULES+'</style><pattern id="pattern'+i+'" patternUnits="userSpaceOnUse" width="4" height="4"><rect width="2" height="4" fill="#0f0"/></pattern></defs><g style="--secondary:rgb(255,0,0);--tertiary:rgb(0,0,255)"><path class="secondary" d="M0 0H20V20H0Z"/><g class="tertiary"><path d="M20 0H40V20H20Z"/></g></g><rect x="0" y="0" width="4" height="4" fill="url(#pattern'+i+')"/>';
  return coa;
 };
 const pixels=async(node:Element,width=40,height=20)=>{
  const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(node)],{type:"image/svg+xml"}));
  try{
   const image=new Image();await new Promise((yes,no)=>{image.onload=yes;image.onerror=no;image.src=url;});
   const c=document.createElement("canvas");c.width=width;c.height=height;const ctx=c.getContext("2d")!;
   ctx.drawImage(image,0,0,width,height);return [...ctx.getImageData(0,0,width,height).data];
  }finally{URL.revokeObjectURL(url);}
 };
 for(let i=1;i<=403;i++) root.append(makeCoa(i));
 const first=root.querySelector("#burgCOA1")!;
 const before=await pixels(first);
 const originals=[...root.querySelectorAll("svg > defs > style")] as SVGStyleElement[];
 const originalMarkup=first.outerHTML;
 const start=performance.now();maintainEmblemStyles(root);const normalizationMs=performance.now()-start;
 const liveComputed=getComputedStyle(first.querySelector(".secondary")!).fill;
 const after=await pixels(first);
 const disabled=originals.filter(s=>s.sheet?.disabled).length;
 const clone=first.cloneNode(true) as SVGSVGElement;clone.id="standalone";root.append(clone);
 const clonedSheetEnabled=!(clone.querySelector("style") as SVGStyleElement).sheet?.disabled;
 const standalone=await pixels(clone);clone.remove();
 const serial=(new XMLSerializer()).serializeToString(first);
 // Detached export clone keeps one canonical sheet at its LAST position; unknown / attributed styles are retained.
 const map=make("svg");map.setAttribute("width","80");map.setAttribute("height","20");
 const defs=make("defs");map.append(defs);for(let i=1;i<=3;i++)defs.append(root.querySelector("#burgCOA"+i)!.cloneNode(true));
 const custom=make("style");custom.textContent="path.secondary{stroke:rgb(0,255,0);stroke-width:1}";defs.insertBefore(custom,defs.children[1]);
 const attributed=make("style");attributed.setAttribute("media","not all");attributed.textContent=EMBLEM_RULES;defs.append(attributed);
 for(let i=1;i<=2;i++){const use=make("use");use.setAttribute("href","#burgCOA"+i);use.setAttribute("x",String((i-1)*40));use.setAttribute("width","40");use.setAttribute("height","20");map.append(use);}
 const exportBefore=await pixels(map,80,20);const last=defs.querySelector("#burgCOA3 style")!;
 compactEmblemCloneStyles(defs);
 const exportAfter=await pixels(map,80,20);
 const retainedLast=defs.querySelectorAll("svg[id] > defs > style").length===1 && !!last.parentNode;
 const unknownPreserved=custom.parentNode===defs && attributed.parentNode===defs;
 const newCoa=makeCoa(404);root.append(newCoa);maintainEmblemStyles(root,newCoa);
 const addedDisabled=(newCoa.querySelector("style") as SVGStyleElement).sheet?.disabled;
 const shared=root.querySelector("[data-emblem-shared-style]")!;
 const sharedLast=shared===root.lastElementChild;
 const formerLast=root.querySelector("#burgCOA404")!;formerLast.remove();
 const deletionComputed=getComputedStyle(first.querySelector(".secondary")!).fill;
 root.innerHTML="";const replacement=makeCoa(405);root.append(replacement);maintainEmblemStyles(root);
 const afterClear=!!root.querySelector("[data-emblem-shared-style]") && !!(replacement.querySelector("style") as SVGStyleElement).sheet?.disabled;
 const same=(a:number[],b:number[])=>a.length===b.length && a.every((v,i)=>v===b[i]);
 const defsCase=make("svg");defsCase.setAttribute("width","40");defsCase.setAttribute("height","20");
 defsCase.innerHTML='<defs><svg id="unreferenced-document"><defs><linearGradient id="nested-gradient"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><style>.paint-reference{fill:url(#nested-gradient)}</style></defs></svg></defs><g id="viewbox"><rect class="paint-reference" width="40" height="20"/><circle cx="100" cy="100" r="5"/></g>';
 const rect=defsCase.querySelector("rect")!, documentDef=defsCase.querySelector("#unreferenced-document")!;
 const originalCase=defsCase.outerHTML, beforeIsolation=await pixels(defsCase);
 const undo=isolate(defsCase,new Set([rect]));
 const nestedDefinitionRetained=documentDef.parentElement!==null;
 const duringIsolation=await pixels(defsCase);undo();
 const restoredOrder=defsCase.outerHTML===originalCase && defsCase.querySelector("#unreferenced-document")===documentDef;
 const assertions={nestedDefinitionRetained,defsPixels:same(beforeIsolation,duringIsolation),restoredOrder,all403Disabled:disabled===403,liveComputed:liveComputed==="rgb(255, 0, 0)",unchangedMarkup:originalMarkup===first.outerHTML,noSerializedDisabled:!serial.includes("disabled"),clonedSheetEnabled,standalonePixels:same(before,standalone),livePixels:same(before,after),exportPixels:same(exportBefore,exportAfter),retainedLast,unknownPreserved,addedDisabled,sharedLast,deletionComputed:deletionComputed==="rgb(255, 0, 0)",afterClear};
 return {assertions,normalizationMs,disabled,pixelValues:before.slice((10*40+10)*4,(10*40+10)*4+4),pass:Object.values(assertions).every(Boolean)};
});
await browser.close();
const report={...result,sourceSha256:createHash("sha256").update(source).digest("hex"),compatSha256:createHash("sha256").update(compatSource).digest("hex"),blocked,kind:"source-backed synthetic SVG/CSS contract; not full-scene parity",time:new Date().toISOString()};
writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(!result.pass) process.exitCode=1;
