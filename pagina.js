/* ============================================================
   pagina.js — roda DENTRO da pagina do YouTube
   ============================================================
   Desvia o audio do <video> para o motor de tom antes de chegar
   ao alto-falante, e desenha a barra de controle.

   Precisa rodar no contexto da pagina, e nao no mundo isolado do
   script de conteudo: la, createMediaElementSource enxerga uma
   copia do elemento e captura silencio.

   Nao usa AudioWorklet de proposito: o worklet exige carregar um
   modulo por endereco blob:, e a politica de seguranca do YouTube
   bloqueia isso — a falha e silenciosa. ScriptProcessor processa
   sem carregar nada de fora.
============================================================ */
(function () {
  'use strict';
  if (window.__noTomAtivo) return;
  window.__noTomAtivo = true;

  var TAM = 4096;              // bloco do ScriptProcessor
  var LIMITE = 12;             // semitons para cada lado
  var semitons = 0;
  var ctx = null, fonte = null, proc = null, video = null;
  var vocL = null, vocR = null;
  var estado = 'procurando o vídeo';

  /* ---------------- ligacao do audio ---------------- */
  function ligar(v) {
    if (proc && video === v) return true;
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();

      video = v;
      if (!fonte) fonte = ctx.createMediaElementSource(v);

      vocL = new window.NoTomVocoder();
      vocR = new window.NoTomVocoder();
      aplicarRazao();

      proc = ctx.createScriptProcessor(TAM, 2, 2);
      proc.onaudioprocess = function (e) {
        var ent = e.inputBuffer, sai = e.outputBuffer;
        var canais = ent.numberOfChannels;
        if (semitons === 0) {
          // tom original: nao mexe, e nao gasta processador
          for (var c = 0; c < sai.numberOfChannels; c++) {
            sai.getChannelData(c).set(ent.getChannelData(Math.min(c, canais - 1)));
          }
          return;
        }
        vocL.processa(ent.getChannelData(0), sai.getChannelData(0));
        if (sai.numberOfChannels > 1) {
          vocR.processa(ent.getChannelData(Math.min(1, canais - 1)), sai.getChannelData(1));
        }
      };

      fonte.connect(proc);
      proc.connect(ctx.destination);
      estado = 'pronto';
      return true;
    } catch (err) {
      estado = 'erro: ' + (err && err.message ? err.message : err);
      pintar();
      return false;
    }
  }

  function aplicarRazao() {
    var r = Math.pow(2, semitons / 12);
    if (vocL) vocL.defineRazao(r);
    if (vocR) vocR.defineRazao(r);
  }

  function definir(n) {
    var antes = semitons;
    semitons = Math.max(-LIMITE, Math.min(LIMITE, n));
    if (semitons === antes) return;
    // sair do zero: limpa o estado, senao o motor comeca com a
    // cauda da janela anterior e solta um estalo
    if (antes === 0 && vocL) { vocL.zerar(); vocR.zerar(); }
    aplicarRazao();
    pintar();
    guardar();
  }

  /* ---------------- barra de controle ---------------- */
  var barra = document.createElement('div');
  barra.id = 'no-tom-barra';
  barra.style.cssText = [
    'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:18px',
    'z-index:2147483647', 'display:flex', 'align-items:center', 'gap:6px',
    'background:rgba(10,10,10,.94)', 'border:1px solid #2A2A2A',
    'border-radius:999px', 'padding:7px 9px', 'box-shadow:0 8px 28px rgba(0,0,0,.5)',
    'font:600 14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    'color:#fff', '-webkit-user-select:none', 'user-select:none'
  ].join(';');

  function botao(texto, aoTocar, tamanho) {
    var b = document.createElement('button');
    b.textContent = texto;
    b.style.cssText = 'width:38px;height:38px;border-radius:50%;border:1px solid #333;'
      + 'background:#1B1B1B;color:#fff;font-size:' + (tamanho || 19) + 'px;cursor:pointer;'
      + 'display:flex;align-items:center;justify-content:center;padding:0;'
      + 'transition:transform .14s cubic-bezier(.34,1.56,.64,1),background .16s';
    b.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (ctx && ctx.state === 'suspended') ctx.resume();
      aoTocar();
    }, true);
    b.addEventListener('pointerdown', function () { b.style.transform = 'scale(.9)'; });
    b.addEventListener('pointerup',   function () { b.style.transform = ''; });
    b.addEventListener('pointerleave',function () { b.style.transform = ''; });
    return b;
  }

  var leitura = document.createElement('span');
  leitura.style.cssText = 'min-width:74px;text-align:center;font-variant-numeric:tabular-nums;'
    + 'font-size:15px;font-weight:700;letter-spacing:.2px';

  barra.appendChild(botao('\u2212', function () { definir(semitons - 1); }, 22));
  barra.appendChild(leitura);
  barra.appendChild(botao('+', function () { definir(semitons + 1); }, 22));

  var zerar = document.createElement('button');
  zerar.textContent = 'original';
  zerar.style.cssText = 'background:none;border:1px solid #333;color:#9A9A9A;'
    + 'border-radius:999px;padding:8px 13px;font-size:12.5px;cursor:pointer;margin-left:3px';
  zerar.addEventListener('click', function (ev) {
    ev.preventDefault(); ev.stopPropagation(); definir(0);
  }, true);
  barra.appendChild(zerar);

  function pintar() {
    if (estado.indexOf('erro') === 0) { leitura.textContent = 'erro'; leitura.title = estado; return; }
    if (!proc) { leitura.textContent = '...'; return; }
    leitura.textContent = semitons === 0 ? 'original'
        : (semitons > 0 ? '+' : '') + semitons;
    leitura.style.color = semitons === 0 ? '#9A9A9A' : '#22C55E';
  }

  /* ---------------- memoria por video ----------------
     Cada musica costuma ser estudada no mesmo tom. Guardar por
     video poupa reajustar toda vez que a pessoa volta. */
  function idDoVideo() {
    var m = location.href.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  }
  function guardar() {
    var id = idDoVideo(); if (!id) return;
    try { localStorage.setItem('notom_' + id, String(semitons)); } catch (e) {}
  }
  function recuperar() {
    var id = idDoVideo(); if (!id) return 0;
    try { return parseInt(localStorage.getItem('notom_' + id) || '0', 10) || 0; } catch (e) { return 0; }
  }

  /* ---------------- laco ---------------- */
  var ultimoId = null;

  function tentar() {
    if (document.body && !document.body.contains(barra)) document.body.appendChild(barra);

    var v = document.querySelector('video');
    if (!v) { estado = 'sem vídeo'; pintar(); return; }

    // o YouTube troca de video sem recarregar a pagina
    var id = idDoVideo();
    if (id !== ultimoId) {
      ultimoId = id;
      if (proc) { semitons = recuperar(); aplicarRazao(); }
    }

    if (!proc) {
      if (ligar(v)) { semitons = recuperar(); aplicarRazao(); }
    }
    pintar();
  }

  // o navegador so libera audio depois de um toque do usuario
  document.addEventListener('click', function () {
    if (ctx && ctx.state === 'suspended') ctx.resume();
    tentar();
  }, true);

  setInterval(tentar, 1200);
  tentar();
})();
