import React from 'react';

// Custom dynamic SVG icon components for high-fidelity branding
export const AndroidIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M17.523 14.625c-.621 0-1.125-.504-1.125-1.125s.504-1.125 1.125-1.125 1.125.504 1.125 1.125-.504 1.125-1.125 1.125zm-11.046 0c-.621 0-1.125-.504-1.125-1.125s.504-1.125 1.125-1.125 1.125.504 1.125 1.125-.504 1.125-1.125 1.125zM6.573 9.818l1.984-3.438.003-.005.748-1.295a.47.47 0 0 0-.172-.642.47.47 0 0 0-.642.172L6.519 6.046a.21.21 0 0 1-.314.074.21.21 0 0 1-.036-.294l2.19-3.168a.47.47 0 0 0-.133-.654.47.47 0 0 0-.654.133L5.023 6.066c-.007.013-.012.027-.02.04L1.665 12.25v7.965h20.67v-7.965l-3.584-6.211zm0 0"/>
  </svg>
);

export const WindowsIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M0 3.449L9.75 2.1v9.45H0V3.449zM0 12.45h9.75v9.45L0 20.551v-8.1zM11.25 1.884L24 0v11.55H11.25V1.884zM11.25 12.45H24v11.55l-12.75-1.884V12.45z"/>
  </svg>
);

export const HarmonyOSIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    {/* Beautifully balanced 8-petal blooming flower style, scaled larger and distinct from a lotus */}
    {/* Petal 1: Leftmost horizontal-ish */}
    <path 
      d="M12 20C9.5 18.0 2.2 16.5 2.2 13.0C2.2 11.5 9.5 14.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 2: Left outer */}
    <path 
      d="M12 20C10.5 16.0 4.5 11.5 4.5 7.5C5.2 6.5 10.5 12.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 3: Left middle */}
    <path 
      d="M12 20C11.2 16.0 7.8 8.5 7.8 4.2C8.8 3.5 11.2 11.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 4: Left inner */}
    <path 
      d="M12 20C11.5 15.5 10.2 8.5 10.5 2.5C11.3 2.5 11.8 12.5 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 5: Right inner */}
    <path 
      d="M12 20C12.5 15.5 13.8 8.5 13.5 2.5C12.7 2.5 12.2 12.5 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 6: Right middle */}
    <path 
      d="M12 20C12.8 16.0 16.2 8.5 16.2 4.2C15.2 3.5 12.8 11.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 7: Right outer */}
    <path 
      d="M12 20C13.5 16.0 19.5 11.5 19.5 7.5C18.8 6.5 13.5 12.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 8: Rightmost horizontal-ish */}
    <path 
      d="M12 20C14.5 18.0 21.8 16.5 21.8 13.0C21.8 11.5 14.5 14.0 12 20Z" 
      fill="#ef4444" 
    />
  </svg>
);

export const DefaultChatIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <line x1="12" y1="7" x2="12" y2="13" />
    <line x1="9" y1="10" x2="15" y2="10" />
  </svg>
);
