// Click (or Enter on) any image in the page body to see it full size.
// Arrow keys or the side buttons step through the page's images; Esc, a click,
// or the close button closes it.  Images that are already links are left alone.

'use strict';
(() => {
  const imgs = [...document.querySelectorAll('main img')].filter((img) => !img.closest('a'));
  if (!imgs.length) return;

  const dlg = document.createElement('dialog');
  dlg.className = 'lightbox';
  dlg.setAttribute('aria-label', 'Image viewer');
  dlg.tabIndex = -1;
  dlg.innerHTML =
    '<img alt="">' +
    '<p class="caption"></p>' +
    '<button type="button" class="lb-btn lb-close" aria-label="Close">&times;</button>' +
    (imgs.length > 1
      ? '<button type="button" class="lb-btn lb-prev" aria-label="Previous image">&lsaquo;</button>' +
        '<button type="button" class="lb-btn lb-next" aria-label="Next image">&rsaquo;</button>'
      : '');
  document.body.append(dlg);

  const big = dlg.querySelector('img');
  const cap = dlg.querySelector('.caption');
  let current = 0;

  function show(n) {
    current = (n + imgs.length) % imgs.length;
    const img = imgs[current];
    big.src = img.currentSrc || img.src;
    big.alt = img.alt;
    cap.textContent = img.closest('figure')?.querySelector('.caption')?.textContent || '';
    cap.hidden = !cap.textContent;
  }

  imgs.forEach((img, n) => {
    img.classList.add('zoomable');
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', `Enlarge: ${img.alt}`);
    const open = () => { show(n); dlg.showModal(); dlg.focus(); };
    img.addEventListener('click', open);
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });

  dlg.addEventListener('click', (e) => {
    if (e.target.closest('.lb-prev')) show(current - 1);
    else if (e.target.closest('.lb-next')) show(current + 1);
    else dlg.close();
  });

  dlg.addEventListener('keydown', (e) => {
    if (imgs.length < 2) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(current - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(current + 1); }
  });
})();
