import type { MessageAnnotation } from '@shared';
import { useI18n } from '../i18n/I18nContext';

/**
 * v0.3.6：已发送消息的引用/批注独立编号卡片（严格保序），正文在分隔线下方。
 * 整体标记 `data-annotation-skip`，不参与划词偏移计算。
 */
export function SentAnnotations({ items }: { items?: MessageAnnotation[] }) {
  const { dict } = useI18n();
  if (!items?.length) return null;
  return (
    <ol className="annotation-list" data-annotation-skip="" data-testid="sent-annotations">
      {items.map((item, index) => (
        <li key={item.id ?? index} className="sent-annotation" data-annotation-id={item.id}>
          <span className="annotation-num">#{index + 1}</span>
          <blockquote title={item.excerpt}>{item.excerpt}</blockquote>
          {item.comment?.trim() ? <p>{item.comment}</p> : <p className="is-quote-only">{dict.ui.v036.annQuoteOnlyTag}</p>}
        </li>
      ))}
    </ol>
  );
}
