import React, { useId } from 'react';

// Default user picture: grey head-and-shoulders silhouette on a light grey circle.
export default function Avatar({ size = 28 }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="avatar-svg" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs><clipPath id={`av${id}`}><circle cx="16" cy="16" r="16" /></clipPath></defs>
      <g clipPath={`url(#av${id})`}>
        <rect width="32" height="32" fill="#cccccc" />
        <circle cx="16" cy="12.6" r="5.6" fill="#656565" />
        <ellipse cx="16" cy="29.5" rx="10.8" ry="8.4" fill="#656565" />
      </g>
    </svg>
  );
}
