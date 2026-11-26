import type { MessageAnnotation } from '@shared';

export function SentAnnotations({ items }: { items?: MessageAnnotation[] }) {
  if (!items?.length) return null;
  return <div className="sent-annotations">{items.map((item, index) =>
    <div key={index} className="sent-annotation">
      <blockquote title={item.excerpt}>{item.excerpt}</blockquote>
      {item.comment && <p>{item.comment}</p>}
    </div>)}</div>;
}
