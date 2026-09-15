'use strict';
const fs=require('fs'),path=require('path');
const ROOT='D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype', DATA=path.join(ROOT,'data');
const result=JSON.parse(fs.readFileSync(path.join(DATA,'result.json'),'utf8'));
const sample=JSON.parse(fs.readFileSync(path.join(DATA,'sample-100.json'),'utf8'));
const entries=result.entries, RANK={exact:3,likely:2,weak:1,miss:0}, POP=sample.meta.layerPopulation;
const popTotal=Object.values(POP).reduce((a,b)=>a+b,0);

// year 口径三选
const neY =(e)=>RANK[e.netease.tier]>=2&&e.netease.best.year;
const mbY =(e)=>RANK[e.musicbrainz.tier]>=2&&e.musicbrainz.best.year;
const l1Y =(e)=>e.local.year>0;
const cnt=(f)=>entries.filter(f).length;
console.log('=== year 口径 ===');
console.log('L1 tag year 可用:',cnt(l1Y));
console.log('netease-only:',cnt(neY));
console.log('preferred-source:',cnt((e)=>RANK[e.netease.tier]>=2?neY(e):mbY(e)));
console.log('either online:',cnt((e)=>neY(e)||mbY(e)));
console.log('L1 OR either online:',cnt((e)=>l1Y(e)||neY(e)||mbY(e)));
console.log('报告 §4.4 = 63');
const perL={};
for(const L of ['A','B','C','D','E']){
  const rs=entries.filter(e=>e.layer===L);
  perL[L]={n:rs.length,l1orOnline:Math.round(rs.filter(e=>l1Y(e)||neY(e)||mbY(e)).length/rs.length*1000)/10,onlineOnly:Math.round(rs.filter(e=>neY(e)||mbY(e)).length/rs.length*1000)/10};
}
console.log('分层:',JSON.stringify(perL),' 报告: A20 B86.7 C44 D93.3 E84');

const w=(f)=>{let s=0;for(const L of ['A','B','C','D','E']){const rs=entries.filter(e=>e.layer===L);if(!rs.length)continue;s+=(POP[L]/popTotal)*(rs.filter(f).length/rs.length);}return Math.round(s*1000)/10;};
console.log('加权 M-02（L1 OR online）:',w(e=>l1Y(e)||neY(e)||mbY(e)),' 报告 67.2');
console.log('加权 M-02（only online）:',w(e=>neY(e)||mbY(e)));

// album 口径
const neA=(e)=>RANK[e.netease.tier]>=2&&e.netease.best.album, mbA=(e)=>RANK[e.musicbrainz.tier]>=2&&e.musicbrainz.best.album;
console.log('\n=== album ===','online either:',cnt(e=>neA(e)||mbA(e)),'报告 64');

// cover 口径
console.log('=== cover ===','netease picId:',cnt(e=>RANK[e.netease.tier]>=2&&e.netease.best.picId),'报告 63');
console.log('=== lyrics ===',cnt(e=>e.netease.lyrics&&e.netease.lyrics.requested&&e.netease.lyrics.chars>0),'报告 54');

// L1 收益复算
const l1tracks=JSON.parse(fs.readFileSync(path.join(DATA,'l1-tracks.json'),'utf8'));
const arr=Array.isArray(l1tracks)?l1tracks:l1tracks.tracks;
console.log('\n=== L1 tracks sample entry ===');
console.log(JSON.stringify(arr[0],null,1).slice(0,900));
const av=(t,k,kind)=>t.availability&&t.availability[k]?t.availability[k][kind]:null;
const usableRaw=(k)=>arr.filter(t=>av(t,k,'raw')===true||av(t,k,'raw')==='usable').length;
console.log('availability key shapes:',JSON.stringify(Object.keys(arr[0].availability||{})));
console.log('artist availability sample:',JSON.stringify(arr.slice(0,3).map(t=>t.availability)));
