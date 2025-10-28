function buildDescriptionPath(path) {
  return path.map((p) => {
    const arrayIndex = /^\[(\d+)\]$/.exec(p);
    if (arrayIndex) return `index ${arrayIndex[1]}`;
    return `"${p}"`;
  }).join(" \u2192 ");
}
function isEqual(a, b, options = {}) {
  if (a === b) return true;
  if (options.customEqual) {
    return options.customEqual(a, b);
  }
  if (options.ignoreCase && typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}
function* deepDiff(a, b, path = [], visited = /* @__PURE__ */ new WeakSet(), options = {}, depth = 0) {
  if (options.maxDepth && depth > options.maxDepth) {
    return;
  }
  if (isEqual(a, b, options)) return;
  const joinedPath = path.join(".");
  const descPath = buildDescriptionPath(path);
  if (typeof a === "object" && a && typeof b === "object" && b) {
    if (visited.has(a) || visited.has(b)) {
      return;
    }
    visited.add(a);
    visited.add(b);
  }
  if (typeof a !== typeof b) {
    if (options.includeNulls === false && (a == null || b == null)) {
      return;
    }
    yield {
      path: joinedPath,
      type: "changed",
      before: a,
      after: b,
      summary: `Changed ${joinedPath} from ${JSON.stringify(a)} to ${JSON.stringify(b)}`,
      description: `Field ${descPath} changed from ${JSON.stringify(a)} to ${JSON.stringify(b)}.`
    };
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      yield* deepDiff(
        a[i],
        b[i],
        [...path, `[${i}]`],
        visited,
        options,
        depth + 1
      );
    }
    return;
  }
  if (typeof a === "object" && a && b) {
    const keys = /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (options.ignoreKeys && options.ignoreKeys.includes(key)) {
        continue;
      }
      const newPath = [...path, key];
      const joinedKeyPath = newPath.join(".");
      const descKeyPath = buildDescriptionPath(newPath);
      if (!(key in a)) {
        if (options.includeNulls === false && b[key] == null) {
          continue;
        }
        yield {
          path: joinedKeyPath,
          type: "added",
          after: b[key],
          summary: `Added ${joinedKeyPath} = ${JSON.stringify(b[key])}`,
          description: `Field ${descKeyPath} was added with value ${JSON.stringify(b[key])}.`
        };
      } else if (!(key in b)) {
        if (options.includeNulls === false && a[key] == null) {
          continue;
        }
        yield {
          path: joinedKeyPath,
          type: "removed",
          before: a[key],
          summary: `Removed ${joinedKeyPath} = ${JSON.stringify(a[key])}`,
          description: `Field ${descKeyPath} was removed. Previous value was ${JSON.stringify(a[key])}.`
        };
      } else {
        yield* deepDiff(a[key], b[key], newPath, visited, options, depth + 1);
      }
    }
  } else {
    if (options.includeNulls === false && (a == null || b == null)) {
      return;
    }
    yield {
      path: joinedPath,
      type: "changed",
      before: a,
      after: b,
      summary: `Changed ${joinedPath} from ${JSON.stringify(a)} to ${JSON.stringify(b)}`,
      description: `Field ${descPath} changed from ${JSON.stringify(a)} to ${JSON.stringify(b)}.`
    };
  }
}
function compare(a, b, options = {}) {
  if (!a || !b) {
    throw new Error("Both objects must be provided for comparison");
  }
  if (typeof a !== "object" || typeof b !== "object") {
    throw new Error("Both parameters must be objects for comparison");
  }
  return [...deepDiff(a, b, [], /* @__PURE__ */ new WeakSet(), options, 0)];
}
function filterByType(diffs, type) {
  return diffs.filter((diff) => diff.type === type);
}
function groupByType(diffs) {
  const result = {
    added: [],
    removed: [],
    changed: []
  };
  return diffs.reduce((groups, diff) => {
    groups[diff.type].push(diff);
    return groups;
  }, result);
}
function getSummary(diffs) {
  const groups = groupByType(diffs);
  return {
    total: diffs.length,
    added: groups.added?.length || 0,
    removed: groups.removed?.length || 0,
    changed: groups.changed?.length || 0
  };
}
function isDeepEqual(a, b, options = {}) {
  try {
    const diffs = compare(a, b, options);
    return diffs.length === 0;
  } catch {
    return false;
  }
}
function getChangedPaths(diffs) {
  return diffs.map((diff) => diff.path);
}
export {
  compare,
  deepDiff,
  filterByType,
  getChangedPaths,
  getSummary,
  groupByType,
  isDeepEqual
};