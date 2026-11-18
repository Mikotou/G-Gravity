import React from 'react';
import { FileCode2 } from 'lucide-react';
import type { FileDiffEntry } from '@shared';

export interface UnifiedDiffBlockProps {
  entry: FileDiffEntry;
  highlighted?: boolean;
}

/** 逐行展示共享层已经对齐的补丁。删除行仅有旧行号，新增行仅有新行号。两列独立留空可保持行号对齐。 */
export function UnifiedDiffBlock({ entry, highlighted }: UnifiedDiffBlockProps): React.ReactElement {
  return (
    <div
      className={`diff-block ${highlighted ? 'is-highlighted' : ''}`}
      data-testid={`diff-file-${entry.filePath}`}
    >
      <div className="diff-head">
        <FileCode2 size={13} />
        <span className="diff-path truncate" title={entry.filePath}>
          {entry.filePath}
        </span>
        <span className="spacer" />
        <span className="cc-add">+{entry.addedLines}</span>
        <span className="cc-del">-{entry.removedLines}</span>
      </div>
      <div className="diff-table">
        {entry.lines.map((line, idx) => (
          <div key={idx} className={`diff-line is-${line.type}`}>
            <span className="diff-num">{line.oldLineNumber ?? ''}</span>
            <span className="diff-num">{line.newLineNumber ?? ''}</span>
            <span className="diff-sign">
              {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
            </span>
            <span className="diff-content">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
