/**
 * Gravity v0.3.6 — 逐行红绿 Diff 数据模型与有界 LCS 算法（纯叶模块，零内部依赖）
 */

export interface DiffHunkLine {
  type: 'context' | 'add' | 'remove';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface FileDiffEntry {
  filePath: string;
  oldText: string;
  newText: string;
  addedLines: number;
  removedLines: number;
  lines: DiffHunkLine[];
  toolCallId?: string;
  updatedAt: string;
}

/**
 * 纯函数：根据修改前后文本计算逐行红绿 Diff（供 Edit/Write 内联展示及右栏 Diff/Files Changed 使用）
 */
export function computeUnifiedLineDiff(
  filePath: string,
  oldText: string,
  newText: string,
  toolCallId?: string
): FileDiffEntry {
  const rawOld = oldText ?? '';
  const rawNew = newText ?? '';
  const oldLines = rawOld.length === 0 ? [] : rawOld.split(/\r?\n/);
  const newLines = rawNew.length === 0 ? [] : rawNew.split(/\r?\n/);
  const lines: DiffHunkLine[] = [];
  let addedLines = 0;
  let removedLines = 0;

  // 先剥离完全相同的公共前缀与公共后缀，使大文件局部修改或相同文件达到 O(N) 精确对齐
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    lines.push({
      type: 'context',
      oldLineNumber: prefixLen + 1,
      newLineNumber: prefixLen + 1,
      content: oldLines[prefixLen],
    });
    prefixLen++;
  }

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > prefixLen &&
    newEnd > prefixLen &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const midOld = oldLines.slice(prefixLen, oldEnd);
  const midNew = newLines.slice(prefixLen, newEnd);

  // 只对两边都不超过 400 行的差异区计算最长公共子序列，使动态规划矩阵的空间开销有界。
  const maxMatrix = 400;
  if (midOld.length === 0 && midNew.length === 0) {
    // 中间无任何差异
  } else if (midOld.length <= maxMatrix && midNew.length <= maxMatrix) {
    const m = midOld.length;
    const n = midNew.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      new Array<number>(n + 1).fill(0)
    );
    // 从末尾向前填表，dp[i][j] 表示两侧剩余行还能匹配的最大行数。随后沿表回溯生成增删行和上下文。
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] =
          midOld[i] === midNew[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        lines.push({
          type: 'context',
          oldLineNumber: prefixLen + i + 1,
          newLineNumber: prefixLen + j + 1,
          content: midOld[i],
        });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({
          type: 'remove',
          oldLineNumber: prefixLen + i + 1,
          content: midOld[i],
        });
        removedLines++;
        i++;
      } else {
        lines.push({
          type: 'add',
          newLineNumber: prefixLen + j + 1,
          content: midNew[j],
        });
        addedLines++;
        j++;
      }
    }
    while (i < m) {
      lines.push({
        type: 'remove',
        oldLineNumber: prefixLen + i + 1,
        content: midOld[i++],
      });
      removedLines++;
    }
    while (j < n) {
      lines.push({
        type: 'add',
        newLineNumber: prefixLen + j + 1,
        content: midNew[j++],
      });
      addedLines++;
    }
  } else {
    // 差异区过大时整段输出旧行删除与新行新增。首尾的公共行仍精确对齐，避免大文件占用过多内存。
    for (let idx = 0; idx < midOld.length; idx++) {
      lines.push({
        type: 'remove',
        oldLineNumber: prefixLen + idx + 1,
        content: midOld[idx],
      });
      removedLines++;
    }
    for (let idx = 0; idx < midNew.length; idx++) {
      lines.push({
        type: 'add',
        newLineNumber: prefixLen + idx + 1,
        content: midNew[idx],
      });
      addedLines++;
    }
  }

  // 两侧相同行可能因中间插入或删除而行号不同，公共尾部的旧、新行号分别从各自偏移计算。
  for (let s = 0; s < oldLines.length - oldEnd; s++) {
    lines.push({
      type: 'context',
      oldLineNumber: oldEnd + s + 1,
      newLineNumber: newEnd + s + 1,
      content: oldLines[oldEnd + s],
    });
  }

  return {
    filePath,
    oldText: rawOld,
    newText: rawNew,
    addedLines,
    removedLines,
    lines,
    toolCallId,
    updatedAt: new Date().toISOString(),
  };
}
