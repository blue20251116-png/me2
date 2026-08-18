const axios=require('axios');
const originalPost=axios.post.bind(axios);

function clean(v){return String(v||'').replace(/\s+/g,' ').trim();}
function inferTopicTag(text){
  const t=clean(text);
  if(!t)return'';
  const rules=[
    [/레시피|재료|소스|양념|볶음|국물|샐러드|떡볶이|김치|요리|에어프라이어|마카로니|계란|치즈빵/i,'레시피'],
    [/다이어트|식단|칼로리|단백질|헬스|운동/i,'다이어트'],
    [/강아지|고양이|반려견|반려묘|반려동물/i,'반려동물'],
    [/차량|자동차|운전|거치대|세차|차박/i,'자동차'],
    [/화장품|선크림|바디워시|피부|미용|뷰티/i,'뷰티'],
    [/아기|육아|분유|유아|어린이|아이랑/i,'육아'],
    [/청소|세탁|주방|욕실|수납|생활용품|살림/i,'살림'],
    [/여행|호텔|숙소|비행기|공항/i,'여행'],
  ];
  for(const [re,tag] of rules)if(re.test(t))return tag;
  return '추천템';
}

axios.post=async function patchedAxiosPost(url,data,config={}){
  const raw=String(url||'');
  const params={...(config?.params||{})};
  const isCreate=/graph\.threads\.net\/v1\.0\/me\/threads(?:$|\?)/i.test(raw);
  const isRoot=isCreate&&params.text&&!params.reply_to_id&&!params.is_carousel_item;
  let injected=false;
  if(isRoot&&!params.topic_tag){
    const tag=inferTopicTag(params.text);
    if(tag){params.topic_tag=tag.slice(0,50).replace(/[.&]/g,'').trim();injected=!!params.topic_tag;}
  }
  const nextConfig={...(config||{}),params};
  if(injected)console.log(`[Threads][TOPIC TAG] 자동선택 topic="${params.topic_tag}" type=${params.media_type||'-'}`);
  try{return await originalPost(raw,data,nextConfig);}
  catch(err){
    const msg=String(err?.response?.data?.error?.message||err?.message||'');
    if(injected&&Number(err?.response?.status)===400&&/topic|tag/i.test(msg)){
      const retryParams={...params};delete retryParams.topic_tag;
      console.warn(`[Threads][TOPIC TAG] topic_tag 거부 → 태그 없이 1회 재시도 reason="${msg}"`);
      return originalPost(raw,data,{...(config||{}),params:retryParams});
    }
    throw err;
  }
};

console.log('[Threads][TOPIC TAG PATCH] 본문 내용 기반 네이티브 주제 자동선택 활성화');
