import { chromium } from "playwright";
for(const [name,options] of [
 ["fixed-integration",{headless:true}],
 ["native-navigation",{headless:true,channel:"chromium",args:["--use-angle=metal","--enable-gpu"]}]
] as const){
 const browser=await chromium.launch(options);
 try{
  const page=await browser.newPage();
  const result=await page.evaluate(()=>{
   const canvas=document.createElement("canvas"),gl=canvas.getContext("webgl2")!;
   const ext=gl.getExtension("WEBGL_debug_renderer_info");
   return {vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),
    unmaskedVendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,
    unmaskedRenderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null};
  });
  console.log(JSON.stringify({name,result}));
 }finally{await browser.close();}
}
