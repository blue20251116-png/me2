const coupangApi = require('./coupangApi');
require('./threadsVideoPatch');

const originalSearchProducts = coupangApi.searchProducts.bind(coupangApi);

coupangApi.searchProducts = async function patchedSearchProducts(accountId, keyword, limit) {
  const products = await originalSearchProducts(accountId, keyword, limit);
  return (Array.isArray(products) ? products : []).map((product) => {
    const productId = String(product?.productId || '').trim();
    if (!/^\d+$/.test(productId)) return product;

    const canonicalUrl = `https://www.coupang.com/vp/products/${productId}`;
    return {
      ...product,
      originalProductUrl: product.url || null,
      url: canonicalUrl,
    };
  });
};

console.log('[Coupang][SHORTLINK PATCH] 상품검색 URL을 canonical 상품 URL로 변환 후 딥링크 단축 사용');
