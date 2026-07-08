import matplotlib.pyplot as plt
import matplotlib.patches as patches
import numpy as np

def draw_penguin():
    fig, ax = plt.subplots(1, 1, figsize=(6, 8))
    ax.set_xlim(-3, 3)
    ax.set_ylim(-4, 4)
    ax.set_aspect('equal')
    ax.axis('off')
    
    # 背景
    ax.set_facecolor('#87CEEB')
    
    # 雪地
    snow = patches.Ellipse((0, -3.5), 6, 1.5, color='white')
    ax.add_patch(snow)
    
    # 身体
    body = patches.Ellipse((0, -0.5), 2.5, 3.5, color='#2C2C2C')
    ax.add_patch(body)
    
    # 肚子
    belly = patches.Ellipse((0, -0.8), 1.8, 2.5, color='white')
    ax.add_patch(belly)
    
    # 头部
    head = patches.Circle((0, 1.5), 1.2, color='#2C2C2C')
    ax.add_patch(head)
    
    # 脸
    face = patches.Circle((0, 1.3), 0.9, color='white')
    ax.add_patch(face)
    
    # 眼睛
    left_eye = patches.Circle((-0.35, 1.6), 0.15, color='#2C2C2C')
    right_eye = patches.Circle((0.35, 1.6), 0.15, color='#2C2C2C')
    ax.add_patch(left_eye)
    ax.add_patch(right_eye)
    
    # 眼睛高光
    left_highlight = patches.Circle((-0.3, 1.65), 0.06, color='white')
    right_highlight = patches.Circle((0.4, 1.65), 0.06, color='white')
    ax.add_patch(left_highlight)
    ax.add_patch(right_highlight)
    
    # 喙
    beak = patches.Polygon([[-0.2, 1.2], [0.2, 1.2], [0, 0.9]], color='#FF8C00')
    ax.add_patch(beak)
    
    # 腮红
    left_cheek = patches.Ellipse((-0.6, 1.1), 0.3, 0.15, color='pink', alpha=0.5)
    right_cheek = patches.Ellipse((0.6, 1.1), 0.3, 0.15, color='pink', alpha=0.5)
    ax.add_patch(left_cheek)
    ax.add_patch(right_cheek)
    
    # 翅膀
    left_wing = patches.Ellipse((-1.3, 0), 0.6, 2, angle=15, color='#2C2C2C')
    right_wing = patches.Ellipse((1.3, 0), 0.6, 2, angle=-15, color='#2C2C2C')
    ax.add_patch(left_wing)
    ax.add_patch(right_wing)
    
    # 脚
    left_foot = patches.Ellipse((-0.5, -2.5), 0.8, 0.3, color='#FF8C00')
    right_foot = patches.Ellipse((0.5, -2.5), 0.8, 0.3, color='#FF8C00')
    ax.add_patch(left_foot)
    ax.add_patch(right_foot)
    
    # 标题
    ax.set_title('🐧 可爱的小企鹅 🐧', fontsize=16, color='#2C2C2C', pad=20)
    
    # 雪花
    np.random.seed(42)
    for _ in range(20):
        x = np.random.uniform(-2.5, 2.5)
        y = np.random.uniform(2, 4)
        size = np.random.uniform(0.02, 0.08)
        snowflake = patches.Circle((x, y), size, color='white', alpha=0.8)
        ax.add_patch(snowflake)
    
    plt.tight_layout()
    plt.savefig('penguin.png', dpi=150, bbox_inches='tight', facecolor='#87CEEB')
    plt.close()
    print('企鹅图片已保存为 penguin.png')

if __name__ == '__main__':
    draw_penguin()