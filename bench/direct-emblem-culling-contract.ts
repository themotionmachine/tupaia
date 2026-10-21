// The `paint` gate check: HiddenEmblemCulling's culling lifecycle and, since PANEND (W4b), the SVG cover it applies
// (svg-cover.ts: #viewbox visibility:hidden + pointer-events:painted under an opaque frame, wanted via update()'s
// fourth argument) in place of the emblem-only motion paint suppression it replaced.
import { chromium } from "playwright";
import ts from "typescript";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const output=process.env.EMBLEM_CULL_OUTPUT!;
if(!output||existsSync(output))throw Error("Unique EMBLEM_CULL_OUTPUT required");
const source=readFileSync("src/renderers/emblems/transient-classes.ts","utf8")+"\n"+readFileSync("src/gpu/svg-cover.ts","utf8")+"\n"+readFileSync("src/gpu/emblem-culling.ts","utf8");
const js=ts.transpileModule(source.replace(/^import[\s\S]*?;$/gm,"").replace(/\bexport /g,""),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const browser=await chromium.launch({headless:true});const context=await browser.newContext({serviceWorkers:"block"});
await context.route("**/*",r=>r.abort());const page=await context.newPage();
await page.addScriptTag({content:"(()=>{"+js+";window.__withCanonicalVisibility=withCanonicalVisibility;window.__HiddenEmblemCulling=HiddenEmblemCulling;window.__emblemSourceClass=emblemSourceClass;window.__restoreHiddenEmblemClasses=restoreHiddenEmblemClasses;})();"});
let result:any;try{result=await page.evaluate(async()=>{
 const ns="http://www.w3.org/2000/svg";const make=(tag:string)=>document.createElementNS(ns,tag);
 const css=document.createElement("style");css.textContent=".viewport-culled{display:none!important;pointer-events:none!important}";document.head.append(css);
 const defs=make("svg");defs.setAttribute("width","0");defs.setAttribute("height","0");defs.innerHTML='<defs><g id="coas"></g></defs>';document.body.append(defs);
 const coas=document.getElementById("coas")!;
 const asset=(id:number)=>{const svg=make("svg");svg.id="burgCOA"+id;svg.setAttribute("viewBox","0 0 200 200");svg.setAttribute("width","200");svg.setAttribute("height","200");svg.style.overflow="hidden";svg.innerHTML='<rect width="200" height="200" fill="red"/>';coas.append(svg);return svg;};
 asset(1);asset(2);coas.querySelector("#burgCOA1")!.id="stateCOA1";
 let root=make("svg") as SVGSVGElement;root.id="map";root.setAttribute("width","100");root.setAttribute("height","100");root.innerHTML='<g id="viewbox"><g id="emblems"><g id="burgEmblems"><use id="near" href="#stateCOA1" x="10" y="10" width="20" height="20"/><use id="far" class="author" href="#burgCOA2" x="1000" y="10" width="20" height="20"/></g></g></g>';document.body.append(root);
 root.style.maskClip="no-clip";root.style.maskMode="alpha";
 const canvas=document.createElement("canvas");canvas.style.cssText="position:fixed;left:0;top:0;width:100px;height:100px;display:block;visibility:visible;opacity:1";document.body.append(canvas);const position=root.getBoundingClientRect();canvas.style.left=position.left+"px";canvas.style.top=position.top+"px";
 const near=root.querySelector("#near")!,far=root.querySelector("#far")!;
 let reads=0;const bbox=SVGGraphicsElement.prototype.getBBox;
 SVGGraphicsElement.prototype.getBBox=function(...a:any[]){reads++;return (bbox as any).apply(this,a);};
 const canonical=root.outerHTML;
 const C=(window as any).__HiddenEmblemCulling;const manager=new C(()=>root,canvas);
 const camera={k:1,x:0,y:0},view={width:100,height:100,dpr:1};const a:Record<string,boolean>={};
 manager.update(camera,view,true);a.maskShorthandWithoutImageIsNotMask=getComputedStyle(root).maskImage==="none"&&manager.status().tracked===2;a.offscreen=far.classList.contains("viewport-culled")&&!near.classList.contains("viewport-culled");const initialReads=reads;const clone=root.cloneNode(true) as Element;(window as any).__restoreHiddenEmblemClasses(root,clone);a.cloneCanonicalClassesExact=clone.outerHTML===canonical;
 manager.update({...camera,x:-1000},view,true);a.absentClassPreserved=(window as any).__emblemSourceClass(near)?.value===null;a.pan=near.classList.contains("viewport-culled")&&!far.classList.contains("viewport-culled");a.noBoundsReadsDuringPan=reads===initialReads;
 manager.update(camera,view,false);a.sourceClassOwnershipReleased=(window as any).__emblemSourceClass(near)===undefined;a.transparencyReveals=!far.classList.contains("viewport-culled")&&!near.classList.contains("viewport-culled");
 manager.update(camera,view,true);canvas.style.visibility="hidden";await new Promise(requestAnimationFrame);a.hiddenCanvasReveals=far.getAttribute("class")==="author"&&!near.classList.contains("viewport-culled");
 canvas.style.visibility="visible";manager.update(camera,view,true);
 far.classList.add("selected");manager.reveal();a.authorClassPreserved=far.classList.contains("selected")&&!far.classList.contains("viewport-culled");
 document.body.style.opacity="0.5";manager.update(camera,view,true);a.translucentAncestorReveals=!far.classList.contains("viewport-culled");document.body.style.opacity="1";
 manager.update(camera,view,true);const group=root.querySelector("#burgEmblems")!;group.setAttribute("filter","url(#unknown)");manager.update(camera,view,true);a.filteredAncestorUnculled=!far.classList.contains("viewport-culled");group.removeAttribute("filter");
 const source2=document.getElementById("burgCOA2")! as unknown as SVGSVGElement;source2.style.overflow="visible";manager.update(camera,view,true);a.overflowVisibleUnculled=!far.classList.contains("viewport-culled");source2.style.overflow="hidden";manager.update(camera,view,true);
 far.setAttribute("x","15");manager.update(camera,view,true);a.geometryEditReveals=!far.classList.contains("viewport-culled");far.setAttribute("x","1000");manager.update(camera,view,true);
 const pending=make("use");pending.id="pending";for(const[k,v]of Object.entries({href:"#burgCOA3",x:"2000",y:"0",width:"20",height:"20"}))pending.setAttribute(k,v);group.append(pending);manager.update(camera,view,true);a.unresolvedRemainsVisible=!pending.classList.contains("viewport-culled");
 asset(3);manager.update(camera,view,true);a.asyncAssetInvalidates=pending.classList.contains("viewport-culled");
 const animatedSource=document.getElementById("burgCOA3")!;const motion=make("animateTransform");motion.setAttribute("attributeName","transform");motion.setAttribute("type","translate");motion.setAttribute("values","0 0;100 0");motion.setAttribute("dur","10s");animatedSource.append(motion);manager.update(camera,view,true);a.animatedSourceUnculled=!pending.classList.contains("viewport-culled");motion.remove();manager.update(camera,view,true);
 const broken=far as unknown as SVGGraphicsElement;
 Object.defineProperty(broken,"getBBox",{value:()=>{throw Error("unusual native geometry");},configurable:true});far.setAttribute("x","1001");manager.update(camera,view,true);a.geometryFailureReveals=!far.classList.contains("viewport-culled");delete(broken as any).getBBox;far.setAttribute("x","1000");manager.update(camera,view,true);
 manager.reveal();a.revealRestores=!far.classList.contains("viewport-culled")&&!pending.classList.contains("viewport-culled");
 manager.update(camera,view,true);const oldRoot=root;const next=root.cloneNode(true) as SVGSVGElement;manager.reset();for(const e of next.querySelectorAll(".viewport-culled"))e.classList.remove("viewport-culled");root=next;oldRoot.replaceWith(root);manager.update(camera,view,true);a.worldReset=!oldRoot.querySelector(".viewport-culled")&&!!root.querySelector("#far.viewport-culled");

 manager.update(camera,view,true,true,false);a.heldCoverWritesNothing=manager.status().paintSuppressed&&!!root.querySelector("#far.viewport-culled");
 manager.update(camera,view,true,true);
 const layer=root.querySelector("#emblems")!,liveNear=root.querySelector("#near")!,viewbox=root.querySelector("#viewbox")!;
 a.coverSuppressesPaint=manager.status().paintSuppressed&&getComputedStyle(layer).visibility==="hidden"&&getComputedStyle(viewbox).pointerEvents==="painted";
 a.coverReplacesCulling=!root.querySelector(".viewport-culled");
 manager.update(camera,view,true,false);
 a.unwantedCoverRestoresPaint=!manager.status().paintSuppressed&&getComputedStyle(layer).visibility==="visible";
 manager.reveal();
 const rect=liveNear.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;
 canvas.style.pointerEvents="none";
 const beforeHit=document.elementFromPoint(x,y);
 manager.update(camera,view,true,true);

 const canonicalRead=(window as any).__withCanonicalVisibility(()=>getComputedStyle(layer).visibility);
 a.canonicalReadTemporarilyReveals=canonicalRead==="visible"&&manager.status().paintSuppressed;
 let threw=false;try{(window as any).__withCanonicalVisibility(()=>{throw Error("probe");});}catch{threw=true;}
 a.canonicalFailureRestoresPaint=threw&&manager.status().paintSuppressed&&getComputedStyle(layer).visibility==="hidden";
 a.nativePaintedHitPreserved=beforeHit===document.elementFromPoint(x,y)&&!!beforeHit?.closest("#emblems");
 const exportClone=root.cloneNode(true) as SVGSVGElement;exportClone.id="fantasyMap";document.body.append(exportClone);
 a.exportCloneRemainsVisible=getComputedStyle(exportClone.querySelector("#emblems")!).visibility==="visible";exportClone.remove();
 manager.update(camera,view,false,true);
 a.transparentFrameRestoresPaint=!manager.status().paintSuppressed&&getComputedStyle(layer).visibility==="visible";

 root.style.overflow="visible";manager.update(camera,view,true,true);
 a.overflowVisibleRootDisablesPaint=!manager.status().paintSuppressed;
 root.style.overflow="hidden";manager.update(camera,view,true,true);
 a.clippedRootAllowsPaint=manager.status().paintSuppressed;
 const hiddenCharge=coas.querySelector("rect")!;hiddenCharge.setAttribute("visibility","hidden");
 await Promise.resolve();a.hiddenSourceImmediatelyDisablesPaint=!manager.status().paintSuppressed;
 manager.update(camera,view,true,true);
 a.hiddenSourceDisablesPaint=!manager.status().paintSuppressed;hiddenCharge.removeAttribute("visibility");manager.update(camera,view,true,true);
 a.clearedSourceEnablesPaint=manager.status().paintSuppressed;
 liveNear.setAttribute("pointer-events","visiblePainted");manager.update(camera,view,true,true);
 a.explicitPointerRuleDisablesPaint=!manager.status().paintSuppressed;liveNear.removeAttribute("pointer-events");
 const dynamicStyle=document.createElement("style");dynamicStyle.textContent="#emblems use:hover{pointer-events:visiblePainted}";document.head.append(dynamicStyle);manager.update(camera,view,true,true);
 a.inactiveHoverRuleDisablesPaint=!manager.status().paintSuppressed;dynamicStyle.remove();

 const hoverAnimation=document.createElement("style");hoverAnimation.textContent="#emblems use:hover{animation:customHiddenCharge 1s infinite}@keyframes customHiddenCharge{to{visibility:hidden}}";document.head.append(hoverAnimation);manager.update(camera,view,true,true);
 a.inactiveHoverAnimationDisablesPaint=!manager.status().paintSuppressed;hoverAnimation.remove();
 // a root effect neither moves hits nor shows: the opaque frame covers the model either way (the renderer forwards
 // or refuses the root filter itself)
 root.setAttribute("filter","url(#unknownRootEffect)");manager.update(camera,view,true,true);
 a.rootEffectKeepsCover=manager.status().paintSuppressed;root.removeAttribute("filter");
 liveNear.setAttribute("tabindex","0");manager.update(camera,view,true,true);
 a.keyboardTargetDisablesPaint=!manager.status().paintSuppressed;liveNear.removeAttribute("tabindex");
 manager.update(camera,view,true,true);
 const hiddenLabel=make("text");hiddenLabel.setAttribute("visibility","hidden");hiddenLabel.textContent="hidden";viewbox.append(hiddenLabel);
 await Promise.resolve();a.addedHiddenContentImmediatelyDisablesPaint=!manager.status().paintSuppressed;
 hiddenLabel.remove();manager.update(camera,view,true,true);
 const label=make("text");label.textContent="label";viewbox.append(label);manager.update(camera,view,true,true);
 a.textStaysVisibleUnderCover=manager.status().paintSuppressed&&getComputedStyle(label).visibility==="visible";label.remove();


 const emptyUse=make("use");emptyUse.setAttribute("x","15");emptyUse.setAttribute("y","15");emptyUse.setAttribute("width","20");emptyUse.setAttribute("height","20");layer.append(emptyUse);manager.update(camera,view,true,true);
 a.deferredEmptyUseIsUnpainted=(emptyUse as SVGGraphicsElement).getBBox().width===0;
 a.deferredEmptyUseDoesNotDisablePaint=manager.status().paintSuppressed;
 // an unresolved reference draws and hits nothing: covered, and checked the moment its definition appears
 emptyUse.setAttribute("href","#missingFutureCOA");manager.update(camera,view,true,true);
 a.unresolvedNonemptyUseKeepsCover=manager.status().paintSuppressed;
 const future=make("g");future.id="missingFutureCOA";future.innerHTML='<rect width="5" height="5" visibility="hidden"/>';coas.append(future);
 await Promise.resolve();a.resolvedHiddenDefinitionImmediatelyDisablesPaint=!manager.status().paintSuppressed;
 future.remove();emptyUse.remove();manager.update(camera,view,true,true);
 const external=make("rect");external.id="externalStateCharge";external.setAttribute("width","20");external.setAttribute("height","20");external.setAttribute("visibility","hidden");defs.querySelector("defs")!.append(external);
 const externalUse=make("use");externalUse.setAttribute("href","#externalStateCharge");coas.querySelector("svg")!.append(externalUse);manager.update(camera,view,true,true);
 a.hiddenReferencedAssetDisablesPaint=!manager.status().paintSuppressed;
 external.removeAttribute("visibility");manager.update(camera,view,true,true);
 a.safeReferencedAssetEnablesPaint=manager.status().paintSuppressed;
 external.setAttribute("visibility","hidden");manager.update(camera,view,true,true);
 a.externalAssetMutationImmediatelyDisablesPaint=!manager.status().paintSuppressed;
 external.removeAttribute("visibility");manager.update(camera,view,true,true);

 const externalDefs=external.parentElement!;externalDefs.setAttribute("visibility","hidden");manager.update(camera,view,true,true);
 // a <use> instance inherits from the <use>, never from its definition's ancestors: the cover changes nothing there
 a.hiddenReferencedAncestorKeepsCover=manager.status().paintSuppressed;externalDefs.removeAttribute("visibility");manager.update(camera,view,true,true);
 externalUse.setAttribute("href","#missingCharge");manager.update(camera,view,true,true);
 a.unresolvedReferencedAssetKeepsCover=manager.status().paintSuppressed;
 externalUse.remove();external.remove();
 manager.update(camera,view,true,true);a.reenabledAfterAuthorRemoval=manager.status().paintSuppressed;
 canvas.style.visibility="hidden";await new Promise(requestAnimationFrame);
 a.previewSynchronouslyRestoresPaint=!manager.status().paintSuppressed&&getComputedStyle(layer).visibility==="visible";canvas.style.visibility="visible";
 manager.update(camera,view,true,true);manager.reset();
 a.resetRestoresPaint=getComputedStyle(layer).visibility==="visible";
 manager.update(camera,view,true,true);
 manager.dispose();a.disposeRestores=!root.querySelector(".viewport-culled")&&getComputedStyle(layer).visibility==="visible";
 SVGGraphicsElement.prototype.getBBox=bbox;
 return {assertions:a,reads,initialReads,pass:Object.values(a).every(Boolean),status:manager.status()};
});
}catch(error){result={pass:false,error:String(error)};}finally{await browser.close();}const report={...result,sourceSha256:createHash("sha256").update(source).digest("hex"),scope:"source-backed Chromium culling lifecycle/geometry; synthetic, not full-scene acceptance",utc:new Date().toISOString()};
writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!result.pass)process.exitCode=1;
