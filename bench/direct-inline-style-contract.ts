
import {chromium} from "playwright";
import ts from "typescript";
import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
const output=process.env.INLINE_STYLE_OUTPUT!;
if(!output||existsSync(output))throw Error("Unique output required");
const source=readFileSync("src/io/export.ts","utf8");
const start=source.indexOf("function styleAttributeSelectors");
const end=source.indexOf("\nexport function saveGeoJsonCells",start);
const candidate=source.slice(start,end);
const baseline=readFileSync("../control/inline-style-baseline.ts","utf8").replace("function inlineStyle(","function originalInlineStyle(");
const js=ts.transpileModule(baseline+"\n"+candidate+"\nwindow.__oldStyle=originalInlineStyle;window.__newStyle=inlineStyle;window.__sequentialStyle=styleAttributeSelectors;",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const browser=await chromium.launch({headless:true});
let result:any;
try{
 const context=await browser.newContext({serviceWorkers:"block"});await context.route("**/*",r=>r.abort());
 const page=await context.newPage();await page.setContent("<html><body></body></html>");await page.addScriptTag({content:js});
 result=await page.evaluate(()=>{
  const w=window as any,ns="http://www.w3.org/2000/svg";
  const select=(root:Element)=>({append:(tag:string)=>{const n=document.createElementNS(ns,tag);root.append(n);return {node:()=>n};},selectAll:(selector:string)=>({each:(f:Function)=>root.querySelectorAll(selector).forEach(n=>f.call(n))})});
  const style=document.createElement("style");document.head.append(style);
  const cases:any[]=[];
  for(const [name,extra]of [["ordinary",""],["style-selector","g[style] > g {fill:green}"],["has-style-selector","svg:has(g[style]) {color: purple;fill:orange}"]] ){
   style.textContent=".parent{fill:red;opacity:.8;--tint:blue}.child{stroke:var(--tint);stroke-width:2px}.special{font-family:serif;font-size:13px}"+extra;
   const groups=Array.from({length:name==="ordinary"?1200:30},(_,i)=>'<g class="parent" transform="translate('+i%100+',0)"><g class="child" stroke-width="3"><rect width="2" height="2"/></g><g class="special" style="fill:blue!important"><text x="0" y="10">Ab</text></g></g>').join("");
   const markup='<svg xmlns="'+ns+'" width="100" height="100">'+groups+'<g id="ruler"><text>Ruler</text></g><g id="scaleBar"><text>Scale</text></g></svg>';
   const outputs:any[]=[];
   for(const [arm,fn]of [["old",w.__oldStyle],["new",w.__newStyle]]){
    const box=document.createElement("div");box.innerHTML=markup;document.body.append(box);const svg=box.firstElementChild!;
    const sequential=w.__sequentialStyle();const begin=performance.now();fn(select(svg));const ms=performance.now()-begin;
    outputs.push({arm,ms,markup:svg.outerHTML,sequential});box.remove();
   }
   cases.push({name,exact:outputs[0].markup===outputs[1].markup,oldMs:outputs[0].ms,newMs:outputs[1].ms,sequential:outputs[1].sequential,bytes:outputs[0].markup.length});
  }
  return {cases,pass:cases.every(c=>c.exact)&&cases[0].sequential===false&&cases.slice(1).every(c=>c.sequential)};
 });
}catch(e){result={pass:false,error:String(e)}}finally{await browser.close();}
const report={...result,sourceSha256:createHash("sha256").update(source).digest("hex"),scope:"Source-backed Chromium exact serialized style strings, inherited/custom/attribute styles and author selectors; synthetic timing, not actual app performance",utc:new Date().toISOString()};
writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.pass)process.exitCode=1;
