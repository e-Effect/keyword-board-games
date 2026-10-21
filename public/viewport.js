(function () {
  function preventGestureZoom(event) {
    if (event.cancelable) event.preventDefault();
  }

  // Safari gesture events need an explicit non-passive handler as well as CSS.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, preventGestureZoom, { passive: false });
  }
  for (const type of ["touchstart", "touchmove"]) {
    document.addEventListener(type, (event) => {
      if (event.touches.length > 1) preventGestureZoom(event);
    }, { passive: false });
  }
})();
