/* ============================================================
   conteudo.js — script de conteudo
   ============================================================
   Uma tarefa: injetar motor.js e pagina.js no contexto real da
   pagina. No mundo isolado do script de conteudo, o
   createMediaElementSource enxerga uma copia do elemento de
   video e captura silencio — foi assim que descobrimos, medindo.
============================================================ */
(function () {
  'use strict';
  var api = (typeof browser !== 'undefined') ? browser : chrome;

  function injetar(arquivo, aoTerminar) {
    var s = document.createElement('script');
    s.src = api.runtime.getURL(arquivo);
    s.async = false;                       // mantem a ordem
    s.onload = function () { s.remove(); if (aoTerminar) aoTerminar(); };
    (document.head || document.documentElement).appendChild(s);
  }

  if (document.getElementById('no-tom-injetado')) return;
  var marca = document.createElement('meta');
  marca.id = 'no-tom-injetado';
  (document.head || document.documentElement).appendChild(marca);

  // o motor primeiro: pagina.js depende dele
  injetar('motor.js', function () { injetar('pagina.js'); });
})();
