/**
 * useCountdownTimer — 通用倒计时 Hook
 * 支持任意秒数倒计时，到期回调
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export function useCountdownTimer(
  seconds: number,
  onTimeout: () => void,
  resetKey?: string,
): { remaining: number; isExpired: boolean } {
  const [remaining, setRemaining] = useState(seconds);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;
  const expiredRef = useRef(false);
  const resetKeyRef = useRef(resetKey);

  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      setRemaining(seconds);
      expiredRef.current = false;
      resetKeyRef.current = resetKey;
    }
  }, [resetKey, seconds]);

  useEffect(() => {
    if (seconds <= 0) return;
    setRemaining(seconds);
    expiredRef.current = false;

    const start = Date.now();
    const timer = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      const left = Math.max(0, Math.round(seconds - elapsed));
      setRemaining(left);
      if (left <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        clearInterval(timer);
        onTimeoutRef.current();
      }
    }, 100);

    return () => clearInterval(timer);
  }, [seconds, resetKey]);

  return { remaining, isExpired: remaining <= 0 };
}