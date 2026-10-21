(function () {
  function swapGhostSetupPieces(kinds, fromIndex, toIndex) {
    if (!Array.isArray(kinds) || kinds.length !== 8 ||
        kinds.filter((kind) => kind === "good").length !== 4 ||
        kinds.filter((kind) => kind === "bad").length !== 4) {
      throw new Error("Ghost setup must contain exactly four pieces of each kind.");
    }
    if (![fromIndex, toIndex].every((index) => Number.isInteger(index) && index >= 0 && index < 8)) {
      throw new RangeError("Invalid setup slot.");
    }
    const next = [...kinds];
    [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
    return next;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { swapGhostSetupPieces };
  } else {
    window.swapGhostSetupPieces = swapGhostSetupPieces;
  }
})();
