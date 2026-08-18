const axios = require('axios');
const benchmark = require('./benchmarkAccounts');
const { db } = require('./db');

const GRAPH_BASE = 'https://graph.threads.net/v1.0';
const previousCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function clean(v){ return String(v || '').trim(); }
function canonical(v){
  try { const u = new URL(String(v || '')); return `${u.origin}${u.pathname}`.replace(/\/media$/i,''); }
  catch { return String(v || '').split(/[?#]/)[0].replace(/\/media$/i,''); }
}
function uniq(a){ return [...new Set((a || []).filter(Boolean))]; }
function isShopLink(v){ return /(?:link\.)?coupang\.com|naver\.me|shopping\.naver\.com|smartstore\.naver\.com|brand\.naver\.com/i.test(String(v || '')); }
function extractUrls(text){
  const s=String(text||'').replace(/\\u0026/gi,'&').replace(/\\u003d/gi,'=').replace(/\\u002f/gi,'/').replace(/\\\//g,'/').replace(/&amp;/gi,'&');
  return uniq([...(s.match(/https?:\/\/[^\s"'<>\\)\]}]+/gi)||[])].filter(isShopLink);
}
function shortcodeFromUrl(url){
  try { const p=new URL(url).pathname.split('/').filter(Boolean); const i=p.indexOf('post'); return i>=0?p[i+1]||'':''; }
  catch { const m=String(url||'').match(/\/post\/([^/?#]+)/); return m?.[1]||''; }
}
function getAccessToken(){
  try {
    const row=db.prepare(`SELECT threads_access_token FROM accounts WHERE threads_access_token IS NOT NULL AND TRIM(threads_access_token)<>'' ORDER BY CASE WHEN id=1 THEN 0 ELSE 1 END,id LIMIT 1`).get();
    return clean(row?.threads_access_token);
  } catch { return ''; }
}
function flattenChildren(value,out=[]){
  if(!value)return out;
  if(Array.isArray(value)){ for(const x of value)flattenChildren(x,out); return out; }
  if(value.data)flattenChildren(value.data,out);
  if(value.media_url||value.thumbnail_url||value.gif_url)out.push(value);
  if(value.children)flattenChildren(value.children,out);
  return out;
}
function mediaFromPost(post){
  const images=[],videos=[];
  const add=(arr,v)=>{const s=clean(v);if(/^https?:\/\//i.test(s)&&!arr.includes(s))arr.push(s);};
  const items=[post,...flattenChildren(post?.children,[])];
  for(const item of items){
    const type=String(item?.media_type||'').toUpperCase();
    if(type.includes('VIDEO')){ add(videos,item.media_url||item.gif_url); }
    else if(type.includes('IMAGE')){ add(images,item.media_url); }
    else {
      if(item?.media_url && /\.mp4(?:\?|$)/i.test(item.media_url))add(videos,item.media_url);
      else add(images,item?.media_url);
    }
  }
  return {images:images.slice(0,10),videos:videos.slice(0,5),hasVideo:videos.length>0};
}

async function fetchExactPublicPost(username,sourceUrl){
  const token=getAccessToken();
  if(!token)return null;
  const wantedCode=shortcodeFromUrl(sourceUrl);
  if(!wantedCode)return null;
  const fields='id,media_product_type,media_type,media_url,gif_url,permalink,username,text,timestamp,shortcode,thumbnail_url,children{id,media_type,media_url,gif_url,thumbnail_url},has_replies,link_attachment_url';
  try {
    const res=await axios.get(`${GRAPH_BASE}/profile_posts`,{params:{username,fields,limit:50,access_token:token},timeout:15000});
    const posts=Array.isArray(res.data?.data)?res.data.data:[];
    const post=posts.find(p=>clean(p.shortcode)===wantedCode||canonical(p.permalink)===canonical(sourceUrl));
    if(!post){ console.log(`[Threads][PUBLIC API] @${username} exact post not found shortcode=${wantedCode}`); return null; }

    const media=mediaFromPost(post);
    const replies=[],affiliateLinks=[];
    if(post.id && post.has_replies!==false){
      try {
        const fieldsReplies='id,text,username,permalink,shortcode,link_attachment_url,is_reply,root_post,replied_to';
        const rr=await axios.get(`${GRAPH_BASE}/${post.id}/conversation`,{params:{fields:fieldsReplies,reverse:false,limit:100,access_token:token},timeout:15000});
        const all=Array.isArray(rr.data?.data)?rr.data.data:[];
        for(const r of all){
          if(clean(r.username).toLowerCase()!==clean(username).replace(/^@/,'').toLowerCase())continue;
          const links=uniq([clean(r.link_attachment_url),...extractUrls(r.text),...extractUrls(JSON.stringify(r))]).filter(isShopLink);
          const packed=[clean(r.text),...links].filter(Boolean).join('\n');
          if(packed)replies.push(packed);
          for(const link of links)if(!affiliateLinks.includes(link))affiliateLinks.push(link);
        }
      } catch(e){
        const api=e.response?.data?.error;
        console.log(`[Threads][PUBLIC API REPLIES] @${username} unavailable code=${api?.code||'-'} message=${api?.message||e.message}`);
      }
    }
    const postLinks=uniq([clean(post.link_attachment_url),...extractUrls(post.text),...extractUrls(JSON.stringify(post))]).filter(isShopLink);
    for(const link of postLinks)if(!affiliateLinks.includes(link))affiliateLinks.push(link);
    if(affiliateLinks.length&&!replies.some(x=>isShopLink(x)))replies.push(`[작성자/게시물 쇼핑링크]\n${affiliateLinks.join('\n')}`);
    console.log(`[Threads][PUBLIC API] @${username} exact=yes replies=${replies.length} affiliateLinks=${affiliateLinks.length} images=${media.images.length} videos=${media.videos.length}`);
    if(affiliateLinks.length)console.log(`[Threads affiliate][API] @${username} count=${affiliateLinks.length} first=${affiliateLinks[0]}`);
    return {sourceText:clean(post.text),authorReplies:replies,affiliateLinks,images:media.images,videos:media.videos,hasVideo:media.hasVideo||!!post.has_replies&&false,exactUrl:true};
  } catch(e){
    const api=e.response?.data?.error;
    console.log(`[Threads][PUBLIC API] @${username} unavailable code=${api?.code||'-'} message=${api?.message||e.message}`);
    return null;
  }
}

benchmark.collectPostDetails = async function publicApiFirstDetails(url,username){
  const api=await fetchExactPublicPost(username,url);
  if(api && api.sourceText && (api.affiliateLinks.length || api.images.length || api.videos.length)){
    // 링크까지 API로 확보되면 브라우저 댓글 DOM에 의존하지 않는다.
    if(api.affiliateLinks.length && (api.images.length||api.videos.length)) return api;
  }
  let browser=null;
  try { browser=await previousCollectPostDetails(url,username); }
  catch(e){ if(!api)throw e; console.log(`[Threads][PUBLIC API FALLBACK] browser failed @${username}: ${e.message}`); }
  if(!api)return browser;
  const authorReplies=uniq([...(api.authorReplies||[]),...(browser?.authorReplies||[])]);
  const affiliateLinks=uniq([...(api.affiliateLinks||[]),...(browser?.affiliateLinks||[]),...authorReplies.flatMap(extractUrls)]).filter(isShopLink);
  if(affiliateLinks.length&&!authorReplies.some(x=>isShopLink(x)))authorReplies.push(`[작성자/게시물 쇼핑링크]\n${affiliateLinks.join('\n')}`);
  const merged={
    ...(browser||{}),
    sourceText:clean(api.sourceText)||clean(browser?.sourceText),
    authorReplies,
    affiliateLinks,
    images:uniq([...(api.images||[]),...(browser?.images||[])]).slice(0,10),
    videos:uniq([...(api.videos||[]),...(browser?.videos||[])]).slice(0,5),
    hasVideo:!!api.hasVideo||!!browser?.hasVideo||(api.videos||[]).length>0||(browser?.videos||[]).length>0,
    exactUrl:true
  };
  if(affiliateLinks.length)console.log(`[Threads affiliate][MERGED] @${username} count=${affiliateLinks.length} first=${affiliateLinks[0]}`);
  return merged;
};

console.log('[Threads][PUBLIC SOURCE PATCH] 공식 profile_posts 우선 + conversation 작성자 댓글 링크 + 원본 media_url fallback 활성화');
