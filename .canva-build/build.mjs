import fs from 'node:fs/promises';
import sharp from 'sharp';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const root = 'C:/Users/weerapat/photobooth';
const build = `${root}/.canva-build`;
const facultyPath = 'C:/Users/weerapat/AppData/Local/Temp/codex-clipboard-bd2efc2a-79e4-417d-8b70-fa6839b6becf.jpg';
const clubPath = 'C:/Users/weerapat/AppData/Local/Temp/codex-clipboard-d58b2c9c-5f0e-4b8c-b7ca-302bcac4cc1a.png';

async function chromaLogo(input, crop, alphaFn, output) {
  const { data, info } = await sharp(input).extract(crop).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    rgba[j] = r; rgba[j + 1] = g; rgba[j + 2] = b; rgba[j + 3] = alphaFn(r, g, b);
  }
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(output);
}
const sietEmblem = `${build}/siet-emblem.png`;
const kmitlLogo = `${build}/kmitl-wordmark.png`;
const clubLogo = `${build}/ie-photo-transparent.png`;
const sietEmblemOnNavy = `${build}/siet-emblem-on-navy.png`;
const kmitlLogoOnNavy = `${build}/kmitl-wordmark-on-navy.png`;
const clubLogoOnNavy = `${build}/ie-photo-on-navy.png`;
await chromaLogo(facultyPath, { left: 63, top: 2, width: 102, height: 112 }, (r,g,b) => {
  const hi = Math.max(r,g,b), lo = Math.min(r,g,b);
  return Math.max(0, Math.min(255, Math.round((hi - lo - 7) * 1.35)));
}, sietEmblem);
await chromaLogo(facultyPath, { left: 291, top: 0, width: 290, height: 126 }, (r,g,b) => {
  const hi = Math.max(r,g,b), lo = Math.min(r,g,b);
  return Math.max(0, Math.min(255, Math.round((hi - lo - 8) * 1.30)));
}, kmitlLogo);
await chromaLogo(clubPath, { left: 96, top: 105, width: 315, height: 295 }, (r,g,b) => Math.max(r,g,b), clubLogo);
for (const [source, output] of [[sietEmblem,sietEmblemOnNavy],[kmitlLogo,kmitlLogoOnNavy],[clubLogo,clubLogoOnNavy]]) {
  const meta = await sharp(source).metadata();
  await sharp({create:{width:meta.width,height:meta.height,channels:4,background:'#08152e'}})
    .composite([{input:source}]).png().toFile(output);
}
const sietBytes = new Uint8Array(await fs.readFile(sietEmblemOnNavy));
const kmitlBytes = new Uint8Array(await fs.readFile(kmitlLogoOnNavy));
const clubBytes = new Uint8Array(await fs.readFile(clubLogoOnNavy));

const ppt = Presentation.create({ slideSize: { width: 384, height: 576 } });
const slide = ppt.slides.add();
slide.background.fill = '#08152e';
const noLine = { style: 'solid', fill: 'none', width: 0 };
function shape(geometry, name, position, fill='none', line=noLine, extra={}) {
  return slide.shapes.add({ geometry, name, position, fill, line, ...extra });
}
function text(name, value, x, y, w, h, fontSize, color, options={}) {
  const s = shape('textbox', name, { left:x, top:y, width:w, height:h }, 'none', noLine);
  s.text = value;
  s.text.style = {
    typeface: options.typeface || 'Tahoma', fontSize, color,
    bold: Boolean(options.bold), italic: Boolean(options.italic),
    alignment: options.align || 'center', verticalAlignment: options.valign || 'middle',
    autoFit: 'shrinkText', wrap: options.wrap || 'none', insets: 0,
    ...(options.outline ? { outline: { style:'solid', fill: options.outline, width: 0.8 } } : {}),
  };
  s.text.insets = 0;
  return s;
}
function curve(name, x, y, w, h, color, width, a, b, c) {
  return shape('custom', name, {left:x,top:y,width:w,height:h}, 'none', {style:'solid',fill:color,width}, {
    customPaths:[{width:w,height:h,commands:[{moveTo:{x:0,y:a}},{cubicBezTo:{x1:w*.28,y1:b,x2:w*.67,y2:c,x:w,y:a}}]}],
  });
}

for (let side=0; side<2; side++) {
  const ox = side*192;
  shape('ellipse', `blue glow ${side+1}`, {left:ox+15,top:114,width:164,height:278}, 'radial(#1a4a80/26 0%, #10234a/10 64%, #10234a/0 100%)');
  shape('ellipse', `lower glow ${side+1}`, {left:ox+29,top:378,width:143,height:182}, 'radial(#183d70/25 0%, #081227/0 100%)');
  for (let i=0;i<22;i++) {
    const x=ox+7+((i*47+19)%178), y=18+((i*83+31)%540), r=i%6===0?1.9:0.85;
    shape('ellipse', `gold particle ${side+1}-${i+1}`, {left:x,top:y,width:r*2,height:r*2}, i%4===0?'#ffdf8a/72':'#d99d3e/45');
  }
  slide.images.add({blob:sietBytes,contentType:'image/png',alt:'SIET institute emblem',fit:'contain',position:{left:ox+18,top:13,width:21,height:23}});
  text(`SIET wordmark ${side+1}`,'SIET',ox+41,10,45,19,19,'#f6f5f2',{align:'left'});
  text(`SIET subtitle ${side+1}`,'School of Industrial\nEducation and Technology',ox+41,28,42,12,4.4,'#e4e6ed',{align:'left',wrap:'square'});
  shape('line',`logo divider ${side+1}`,{left:ox+86,top:13,width:0,height:26},'none',{style:'solid',fill:'#c99a40',width:1});
  slide.images.add({blob:kmitlBytes,contentType:'image/png',alt:'KMITL wordmark',fit:'contain',position:{left:ox+92,top:12,width:77,height:26}});

  curve(`header gold sweep ${side+1}`,ox+1,48,190,11,'#d9a644/70',1.2,6,0,11);
  curve(`header blue sweep ${side+1}`,ox+1,51,190,8,'#4776b5/40',1.1,5,10,1);

  for (let i=0;i<3;i++) {
    const y=73+i*109;
    shape('roundRect',`photo ${side+1}-${i+1} gold frame`,{left:ox+7,top:y,width:178,height:100},'#fffdf8',{style:'solid',fill:'#e0ad48',width:2.3},{borderRadius:8});
    shape('roundRect',`photo ${side+1}-${i+1} inner frame`,{left:ox+9.5,top:y+2.5,width:173,height:95},'#fffdf8',{style:'solid',fill:'#141d37',width:0.7},{borderRadius:7});
  }

  curve(`footer gold sweep ${side+1}`,ox+8,401,176,9,'#e3ad49/90',1.6,6,0,9);
  curve(`footer highlight ${side+1}`,ox+16,406,160,8,'#f5d992/60',0.75,5,8,1);
  text(`event yearline ${side+1}`,'Alumni Reunion 2026',ox+9,411,174,15,11.4,'#fff0bd',{bold:true});
  text(`event title first ${side+1}`,'บัณฑิตจิต คืนสู่เหย้า',ox+5,426,182,22,17.1,'#ffda75',{bold:true});
  text(`event title second ${side+1}`,'เรามีคุณครู',ox+7,448,178,22,18.3,'#ffda75',{bold:true});
  text(`event subtitle ${side+1}`,'“ครุศาสตร์วิศวกรรม”',ox+10,470,172,14,10.6,'#f3eee4',{bold:true});
  text(`event date ${side+1}`,'วันเสาร์ที่ 17 ตุลาคม พ.ศ. 2569',ox+7,484,178,12,7.3,'#ffd45c',{bold:true});
  shape('line',`footer divider ${side+1}`,{left:ox+12,top:499,width:168,height:0},'none',{style:'solid',fill:'#bd913d/85',width:0.9});
  text(`bottom event name ${side+1}`,'Alumni Reunion\n2026',ox+13,506,92,37,9.4,'#f7f1e7',{align:'left',bold:true,wrap:'square'});
  text(`bottom multiplication sign ${side+1}`,'×',ox+119,510,16,28,18,'#ffb33d',{bold:true});
  slide.images.add({blob:clubBytes,contentType:'image/png',alt:'IE-PHOTO club logo',fit:'contain',position:{left:ox+143,top:502,width:34,height:45}});
  shape('line',`bottom gold accent ${side+1}`,{left:ox+10,top:563,width:33,height:0},'none',{style:'solid',fill:'#dfaa46/70',width:1});
  shape('line',`bottom gold accent right ${side+1}`,{left:ox+149,top:563,width:33,height:0},'none',{style:'solid',fill:'#dfaa46/70',width:1});
}
shape('line','center trim',{left:192,top:4,width:0,height:568},'none',{style:'solid',fill:'#bd9140/85',width:1.3});

await fs.mkdir(`${build}/renders`,{recursive:true});
const preview=await ppt.export({slide,format:'png',scale:2});
await fs.writeFile(`${build}/renders/slide-01.png`,new Uint8Array(await preview.arrayBuffer()));
const pptx=await PresentationFile.exportPptx(ppt);
await pptx.save(`${build}/candidate.pptx`);
console.log('Draft created with editable text, frames, rules, accents, and logo images.');
