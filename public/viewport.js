(function () {
  const editableSelector = "input, textarea, [contenteditable='true']";
  for (const type of ["selectstart", "contextmenu", "dragstart"]) {
    document.addEventListener(type, (event) => {
      if (!event.target?.closest?.(editableSelector) && event.cancelable) {
        event.preventDefault();
      }
    }, { passive: false });
  }

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
