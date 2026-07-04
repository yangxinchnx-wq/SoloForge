import React, { useEffect, useRef, useState } from 'react';

export type MountTransitionVariant = 'fade' | 'fade-scale' | 'slide-up' | 'slide-right' | 'height';

interface MountTransitionProps {
  show: boolean;
  variant?: MountTransitionVariant;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
  unmountOnExit?: boolean;
  children: React.ReactNode;
}

/**
 * Drop-in replacement for `AnimatePresence` + `motion.div` exit animations.
 *
 * Renders the children immediately when `show` becomes true. When `show`
 * becomes false, applies a CSS class that triggers the exit animation, then
 * unmounts the children after the animation finishes (unless
 * `unmountOnExit` is false).
 *
 * Why this exists: `motion/react` does a lot of bookkeeping per mount
 * (scheduler, spring solver, projection cache). For pure opacity/transform
 * fade-outs a CSS keyframe is identical visually and ~free at runtime.
 */
export const MountTransition: React.FC<MountTransitionProps> = ({
  show,
  variant = 'fade-scale',
  duration = 200,
  className = '',
  style,
  unmountOnExit = true,
  children,
}) => {
  const [shouldRender, setShouldRender] = useState(show);
  const [isExiting, setIsExiting] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (show) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setIsExiting(false);
      setShouldRender(true);
      return;
    }

    if (!shouldRender) return;

    setIsExiting(true);
    timerRef.current = window.setTimeout(() => {
      setIsExiting(false);
      if (unmountOnExit) {
        setShouldRender(false);
      }
      timerRef.current = null;
    }, duration);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [show, duration, unmountOnExit, shouldRender]);

  if (!shouldRender) return null;

  const variantClass =
    variant === 'fade' ? 'sf-anim-fade' :
    variant === 'fade-scale' ? 'sf-anim-fade-scale' :
    variant === 'slide-up' ? 'sf-anim-slide-up' :
    variant === 'slide-right' ? 'sf-anim-slide-right' :
    variant === 'height' ? 'sf-anim-height' :
    'sf-anim-fade-scale';

  const containerStyle: React.CSSProperties = isExiting
    ? { ...(style || {}), pointerEvents: 'none' }
    : style || {};

  return (
    <div
      className={`${variantClass} ${isExiting ? 'sf-exit' : ''} ${className}`}
      style={containerStyle}
      aria-hidden={isExiting || undefined}
    >
      {children}
    </div>
  );
};
