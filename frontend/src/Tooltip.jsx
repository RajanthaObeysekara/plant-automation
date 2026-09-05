export default function Tip({ text, children, className = '' }) {
  return (
    <span className={`tip ${className}`} data-tip={text} tabIndex={0}>
      {children}
    </span>
  );
}
