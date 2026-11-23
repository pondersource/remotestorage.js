const {createServer}=require('node:http');
const {readFile}=require('node:fs/promises');
const {resolve}=require('node:path');
const routes={
  '/onedrive-test.html':[resolve(__dirname,'onedrive-test.html'),'text/html'],
  '/remotestorage-all.js':[resolve(__dirname,'../../release/remotestorage-all.js'),'text/javascript'],
  '/widget.js':[resolve(__dirname,'../../../remotestorage-widget/build/widget.js'),'text/javascript']
};
createServer(async(req,res)=>{
  const file=routes[new URL(req.url,'http://localhost').pathname];
  if(!file){res.writeHead(404).end();return;}
  try{res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store'});res.end(await readFile(file[0]));}
  catch{res.writeHead(500).end('Build rs.js and the sibling widget checkout first.');}
}).listen(8765,'0.0.0.0',()=>console.log('OneDrive test: http://localhost:8765/onedrive-test.html'));
