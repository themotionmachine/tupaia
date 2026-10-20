import { chromium } from "playwright";
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const source=readFileSync("src/gpu/compat-assets.ts","utf8");
const styles=readFileSync("src/renderers/emblems/styles.ts","utf8");
const rules=styles.match(/export const EMBLEM_RULES = `([\s\S]*?)`;/)![1];
const js=ts.transpileModule("const EMBLEM_RULES="+JSON.stringify(rules)+";"+source.replace(/^import .+;$/gm,"").replace(/\bexport /g,""),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const compatSource=readFileSync("src/gpu/compat.ts","utf8");
const compatJs=ts.transpileModule(compatSource.replace(/^import .+;$/gm,"").replace(/^export \{.+\} from .+;$/gm,"").replace(/\bexport /g,""),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const browser=await chromium.launch({headless:true});const context=await browser.newContext({serviceWorkers:"block"});
await context.route("**/*",route=>route.abort());const page=await context.newPage();
await page.addScriptTag({content:"(()=>{"+js+compatJs+";window.__rasterizeRun=rasterizeRun;window.__isolateEmblems=isolateEmblemDefinitions;})();"});
let result:any;
try{result=await page.evaluate(async({rules})=>{
 const ns="http://www.w3.org/2000/svg", assertions:Record<string,boolean>={};
 const make=(body:string)=>{const svg=document.createElementNS(ns,"svg");svg.setAttribute("xmlns",ns);svg.setAttribute("width","120");svg.setAttribute("height","80");svg.innerHTML=body;return svg;};
 const asset=(id:number,body:string)=>'<svg id="burgCOA'+id+'" viewBox="0 0 40 40">'+body+'</svg>';
 const isolate=(root:Element)=>(window as any).__isolateEmblems(root) as ()=>void;
 const unchanged=(root:Element)=>{const before=root.outerHTML,undo=isolate(root);const same=root.outerHTML===before;undo();return same&&root.outerHTML===before;};
 const basic=make('<defs>'+asset(1,'<rect width="40" height="40" fill="red"/>')+asset(2,'<rect width="40" height="40" fill="blue"/>')+'</defs><use href="#burgCOA1" width="40" height="40"/>');
 const original=basic.outerHTML,undo=isolate(basic);
 assertions.unusedRemoved=!basic.querySelector("#burgCOA2")&&!!basic.querySelector("#burgCOA1");undo();assertions.exactRestore=basic.outerHTML===original;
 const descendant=make('<defs>'+asset(1,'<defs><linearGradient id="paint"><stop stop-color="red"/></linearGradient><path id="charge" d="M0 0H40V40H0Z" fill="url(#paint)"/></defs>')+asset(2,'<use href="#charge"/>')+asset(3,'<rect width="40" height="40" fill="blue"/>')+'</defs><use href="#burgCOA2" width="40" height="40"/><rect x="40" width="40" height="40" fill="url(#paint)"/>');
 const descOriginal=descendant.outerHTML;const undoDesc=isolate(descendant);
 assertions.transitiveDescendants=!!descendant.querySelector("#burgCOA1")&&!!descendant.querySelector("#burgCOA2")&&!descendant.querySelector("#burgCOA3");
 const pruned=descendant.outerHTML;undoDesc();assertions.descendantExactRestore=descendant.outerHTML===descOriginal;
 const pixels=async(markup:string)=>{const url=URL.createObjectURL(new Blob([markup],{type:"image/svg+xml"}));try{const image=new Image();await new Promise((yes,no)=>{image.onload=yes;image.onerror=no;image.src=url;});const c=document.createElement("canvas");c.width=120;c.height=80;const ctx=c.getContext("2d")!;ctx.drawImage(image,0,0);return ctx.getImageData(0,0,120,80).data;}finally{URL.revokeObjectURL(url);}};
 const a=await pixels(descOriginal),b=await pixels(pruned);assertions.descendantPixels=a.every((v,i)=>v===b[i]);
 const duplicates=make('<defs>'+asset(1,'<path id="duplicate" d="M0 0H40V40H0Z"/>')+asset(2,'<path id="duplicate" d="M0 0H20V20H0Z"/>')+asset(3,'')+'</defs><use href="#duplicate"/>');const u=isolate(duplicates);assertions.duplicateOwners=!!duplicates.querySelector("#burgCOA1")&&!!duplicates.querySelector("#burgCOA2")&&!duplicates.querySelector("#burgCOA3");u();
 const variable=make('<defs>'+asset(1,'<linearGradient id="paint"><stop stop-color="red"/></linearGradient>')+asset(2,'')+'</defs><g style="--paint:url(%23paint)"><rect width="20" height="20" fill="var(--paint)"/></g>');const uv=isolate(variable);assertions.encodedVariableReference=!!variable.querySelector("#burgCOA1")&&!variable.querySelector("#burgCOA2");uv();
 const percentage=make('<defs>'+asset(1,'<rect width="100%" height="100%" fill="red"/>')+asset(2,'')+'</defs><g style="width:100%;--paint:url(%23burgCOA1)"><use href="#burgCOA1"/></g>');const up=isolate(percentage);assertions.percentGeometryIsNotMalformedEncoding=!!percentage.querySelector("#burgCOA1")&&!percentage.querySelector("#burgCOA2");up();
 const styleOwner=make('<defs>'+asset(1,'<defs><style>'+rules+'</style></defs>')+asset(2,'')+'</defs>');const us=isolate(styleOwner);assertions.styleOwnerRetained=!!styleOwner.querySelector("#burgCOA1")&&!styleOwner.querySelector("#burgCOA2");us();
 const neutral=make('<style>#armies text {stroke: none; fill: #fff; text-shadow: 0 0 4px #000; dominant-baseline: central; text-anchor: middle; font-family: Helvetica; fill-opacity: 1;}#armies text.regimentIcon {font-size: .8em;}</style><style>.viewport-culled{display:none!important;pointer-events:none!important}</style><defs>'+asset(1,'')+'</defs>');const un=isolate(neutral);assertions.knownAppStylesAllowClosure=!neutral.querySelector("#burgCOA1");un();
 // the candidate graph is cached per root (W4 RESUME): a second cut of the same root whose outside content now names
 // another COA retains that one, and the cut after restores exactly
 const cached=make('<defs>'+asset(1,'<rect width="40" height="40" fill="red"/>')+asset(2,'<use href="#burgCOA3"/>')+asset(3,'<rect width="40" height="40" fill="blue"/>')+'</defs><use id="pick" href="#burgCOA1"/>');
 const cachedOriginal=cached.outerHTML;let uc=isolate(cached);assertions.cachedFirst=!!cached.querySelector("#burgCOA1")&&!cached.querySelector("#burgCOA2")&&!cached.querySelector("#burgCOA3");uc();
 cached.querySelector("#pick")!.setAttribute("href","#burgCOA2");uc=isolate(cached);assertions.cachedFollowsOutside=!cached.querySelector("#burgCOA1")&&!!cached.querySelector("#burgCOA2")&&!!cached.querySelector("#burgCOA3");uc();
 cached.querySelector("#pick")!.setAttribute("href","#burgCOA1");assertions.cachedExactRestore=cached.outerHTML===cachedOriginal;
 const unknownStyle=make('<style>svg:nth-child(2){fill:red}</style><defs>'+asset(1,'')+asset(2,'')+'</defs>');assertions.unknownStylesFailClosed=unchanged(unknownStyle);
 const escaped=make('<defs>'+asset(1,'')+asset(2,'')+'</defs><g style="fill:url(#bur'+'\\67COA1)"/>');assertions.escapedReferenceFailClosed=unchanged(escaped);
 const smil=make('<defs>'+asset(1,'<animate attributeName="opacity" dur="1s"/>')+asset(2,'')+'</defs>');assertions.smilFailClosed=unchanged(smil);
 const nested=make('<defs>'+asset(1,'<defs>'+asset(2,'')+'</defs>')+'</defs>');assertions.nestedCandidatesFailClosed=unchanged(nested);
 const integrated=make('<defs>'+asset(1,'<rect width="40" height="40" fill="red"/>')+asset(2,'<rect width="40" height="40" fill="blue"/>')+'</defs><g id="viewbox" transform="translate(2 3)"><g id="kept"><use href="#burgCOA1" width="40" height="40"/></g><g><rect width="120" height="80" fill="green"/></g></g>');
 integrated.setAttribute("preserveAspectRatio","xMaxYMin slice");
 const beforeIntegrated=integrated.outerHTML,kept=integrated.querySelector("#kept")!,serialize=XMLSerializer.prototype.serializeToString,raster=(window as any).__rasterizeRun;
 let injected=false,serializedCount=-1;
 XMLSerializer.prototype.serializeToString=function(node){if(node===integrated){injected=true;throw Error("injected serializer failure");}return serialize.call(this,node);};
 try{await raster(integrated,[kept],{x:0,y:0,width:120,height:80},120,80,false);}catch(error){assertions.serializationFailurePropagates=String(error).includes("injected serializer failure");}finally{XMLSerializer.prototype.serializeToString=serialize;}
 assertions.serializationFailureRestores=injected&&integrated.outerHTML===beforeIntegrated;
 XMLSerializer.prototype.serializeToString=function(node){if(node===integrated)serializedCount=integrated.querySelectorAll("defs > svg[id]").length;return serialize.call(this,node);};
 try{const pending=raster(integrated,[kept],{x:0,y:0,width:120,height:80},120,80,false);assertions.productRestoresBeforeDecodeYield=integrated.outerHTML===beforeIntegrated;const canvas=await pending;const pixel=canvas.getContext("2d")!.getImageData(10,10,1,1).data;assertions.productPrunesAndRenders=serializedCount===1&&pixel[0]===255&&pixel[1]===0&&pixel[2]===0&&pixel[3]===255;assertions.productSuccessRestores=integrated.outerHTML===beforeIntegrated;canvas.width=0;}finally{XMLSerializer.prototype.serializeToString=serialize;}
 for(const ratio of [null,"","xMinYMax meet"]){
  if(ratio===null)integrated.removeAttribute("preserveAspectRatio");else integrated.setAttribute("preserveAspectRatio",ratio);
  for(const screen of [false,true]){
   const before=integrated.outerHTML,pending=raster(integrated,[kept],{x:0,y:0,width:120,height:80},120,80,screen);
   const synchronous=integrated.outerHTML===before,canvas=await pending;
   assertions["aspectRatioExact:"+String(ratio)+":"+screen]=synchronous&&integrated.outerHTML===before;
   canvas.width=0;
  }
 }
 return {assertions,pass:Object.values(assertions).every(Boolean)};
},{rules});}catch(error){result={pass:false,error:String(error)};}finally{await browser.close();}
const report={...result,scope:"source-backed synthetic dependency closure, not actual scene acceptance",sourceSha256:createHash("sha256").update(source).digest("hex"),utc:new Date().toISOString()};
writeFileSync(process.env.ASSET_CONTRACT_OUTPUT!,JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.pass)process.exitCode=1;
