import React, { useState } from 'react';

interface LoginFormProps {
  onSubmit?: (username: string, password: string) => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({ onSubmit }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    try {
      if (onSubmit) {
        await onSubmit(username, password);
      } else {
        // 模拟登录请求
        console.log('登录信息:', { username, password });
        await new Promise(resolve => setTimeout(1000));
        alert('登录成功！');
      }
    } catch (error) {
      console.error('登录失败:', error);
      alert('登录失败，请重试');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-[var(--color-surface)] rounded-2xl shadow-lg border border-[var(--color-outline)] p-8">
          {/* 标题区域 */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-[var(--color-on-surface)] mb-2">
              欢迎回来
            </h1>
            <p className="text-[var(--color-on-surface)] opacity-65">
              请输入您的账户信息以继续
            </p>
          </div>

          {/* 表单 */}
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* 用户名输入框 */}
            <div>
              <label 
                htmlFor="username" 
                className="block text-sm font-medium text-[var(--color-on-surface)] mb-2"
              >
                用户名
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
                required
                className="w-full px-4 py-3 bg-[var(--color-bg)] border border-[rgba(var(--color-primary-rgb),0.3)] rounded-xl text-[var(--color-on-surface)] placeholder-[var(--color-on-surface)] placeholder-opacity-50 focus:outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[rgba(var(--color-primary-rgb),0.25)] transition-all duration-200"
              />
            </div>

            {/* 密码输入框 */}
            <div>
              <label 
                htmlFor="password" 
                className="block text-sm font-medium text-[var(--color-on-surface)] mb-2"
              >
                密码
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                required
                className="w-full px-4 py-3 bg-[var(--color-bg)] border border-[rgba(var(--color-primary-rgb),0.3)] rounded-xl text-[var(--color-on-surface)] placeholder-[var(--color-on-surface)] placeholder-opacity-50 focus:outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[rgba(var(--color-primary-rgb),0.25)] transition-all duration-200"
              />
            </div>

            {/* 记住我选项 */}
            <div className="flex items-center justify-between">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-[rgba(var(--color-primary-rgb),0.3)] text-[var(--color-primary)] focus:ring-[rgba(var(--color-primary-rgb),0.25)]"
                />
                <span className="ml-2 text-sm text-[var(--color-on-surface)] opacity-65">
                  记住我
                </span>
              </label>
              <a 
                href="#" 
                className="text-sm text-[var(--color-primary)] hover:underline"
              >
                忘记密码？
              </a>
            </div>

            {/* 登录按钮 */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 bg-[var(--color-primary)] hover:opacity-90 text-white font-semibold rounded-xl shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <div className="flex items-center justify-center">
                  <svg 
                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" 
                    xmlns="http://www.w3.org/2000/svg" 
                    fill="none" 
                    viewBox="0 0 24 24"
                  >
                    <circle 
                      className="opacity-25" 
                      cx="12" 
                      cy="12" 
                      r="10" 
                      stroke="currentColor" 
                      strokeWidth="4"
                    ></circle>
                    <path 
                      className="opacity-75" 
                      fill="currentColor" 
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  登录中...
                </div>
              ) : (
                '登录'
              )}
            </button>
          </form>

          {/* 分隔线 */}
          <div className="mt-8">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[var(--color-outline)]"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-[var(--color-surface)] text-[var(--color-on-surface)] opacity-65">
                  或者
                </span>
              </div>
            </div>
          </div>

          {/* 其他登录方式 */}
          <div className="mt-6 grid grid-cols-2 gap-4">
            <button
              type="button"
              className="py-2 px-4 border border-[var(--color-outline)] rounded-xl text-[var(--color-on-surface)] hover:bg-[var(--color-surface-bright)] transition-colors duration-200"
            >
              微信登录
            </button>
            <button
              type="button"
              className="py-2 px-4 border border-[var(--color-outline)] rounded-xl text-[var(--color-on-surface)] hover:bg-[var(--color-surface-bright)] transition-colors duration-200"
            >
              GitHub登录
            </button>
          </div>

          {/* 注册链接 */}
          <div className="mt-8 text-center">
            <p className="text-sm text-[var(--color-on-surface)] opacity-65">
              还没有账户？{' '}
              <a 
                href="#" 
                className="text-[var(--color-primary)] hover:underline font-medium"
              >
                立即注册
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};