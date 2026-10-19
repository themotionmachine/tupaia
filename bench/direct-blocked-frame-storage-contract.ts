import {chromium} from "playwright";
import {createServer} from "node:http";
import {writeFileSync} from "node:fs";
const server=createServer((_,response)=>response.end("<!doctype html><html><body>local diagnostic</body></html>"));
await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
const address=server.address() as any,origin="http://127.0.0.1:"+address.port;
const browser=await chromium.launch({headless:true,channel:"chromium",args:["--use-angle=metal","--enable-gpu"]});
const results=[];
try{
 for(const guarded of [false,true]){
  const context=await browser.newContext({serviceWorkers:"block"}),errors:any[]=[];
  await context.addInitScript(({guarded,origin})=>{
   if(guarded&&location.origin!==origin)return;
   localStorage.setItem("autosaveInterval","0");localStorage.setItem("azgaarAssistant","hide");
  },{guarded,origin});
  await context.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();page.on("pageerror",error=>errors.push({message:error.message,stack:error.stack,frames:page.frames().map(frame=>frame.url())}));
  await page.goto(origin);await page.evaluate(()=>{const frame=document.createElement("iframe");frame.src="https://deorum.vercel.app/encounter/48108";document.body.append(frame);});
  await page.waitForTimeout(700);
  results.push({guarded,errors,mainAutosave:await page.evaluate(()=>localStorage.getItem("autosaveInterval"))});
  await context.close();
 }
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
writeFileSync(process.env.BLOCKED_STORAGE_OUTPUT!,JSON.stringify({scope:"Controlled reproduction of existing initScript on blocked foreign iframe; no app/source/gate changes",results},null,2),{flag:"wx"});console.log(JSON.stringify(results));
