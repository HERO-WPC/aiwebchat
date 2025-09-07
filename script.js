// --- 全局变量定义 ---
// 通过 const 定义常量，保存对页面上重要 DOM 元素的引用。
// 这样做可以避免在函数中反复查询 DOM，提高性能。

const chatWindow = document.getElementById('chat-window'); // 聊天消息显示区域
const chatForm = document.getElementById('chat-form'); // 底部的表单
const messageInput = document.getElementById('message-input'); // 文本输入框
const modelSelect = document.getElementById('model-select'); // 模型选择下拉框
const sendButton = chatForm.querySelector('button[type="submit"]'); // 发送按钮
const uploadButton = document.getElementById('upload-button'); // 图片上传按钮
const fileInput = document.getElementById('file-input'); // 隐藏的文件选择框
const imagePreviewContainer = document.getElementById('image-preview-container'); // 图片预览区域

// --- 应用状态管理 ---
// 使用 let 定义变量，用于存储应用在运行过程中的状态。

let conversationHistory = []; // 存储整个对话历史记录，用于发送给 API 以维持上下文
let attachedImageBase64 = null; // 用于存储当前选中的、已编码为 Base64 的图片数据。发送后会清空。

// --- 核心功能函数 ---

/**
 * 向聊天窗口添加一条消息。这是一个非常核心的 UI 更新函数。
 * 它可以灵活处理只包含文本、只包含图片或图文混合的消息。
 * @param {string} sender - 消息的发送者，'user' 或 'assistant'。这个参数决定了消息气泡的样式和位置。
 * @param {string} [text] - (可选) 消息的文本内容。
 * @param {string|null} [imageBase64] - (可选) 要在消息中显示的图片的 Base64 数据 URL。
 * @returns {HTMLElement} 返回创建的消息内容元素，用于后续可能的更新（例如流式输出）
 */
function addMessage(sender, text, imageBase64 = null) {
    // 1. 创建消息的最外层容器 <div>
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender); // 添加 'message' 和发送者 ('user'/'assistant') 类名

    // 2. 创建消息内容的容器 <div>
    const contentElement = document.createElement('div');
    contentElement.classList.add('message-content');

    // 3. 如果存在图片数据，则创建并添加图片元素
    if (imageBase64) {
        const imageElement = document.createElement('img');
        imageElement.src = imageBase64; // Base64 数据可以直接作为图片的 src
        imageElement.alt = '用户上传的图片';
        contentElement.appendChild(imageElement); // 将图片添加到内容容器中
    }

    // 4. 如果存在文本内容，则创建并添加文本节点
    // 使用 createTextNode 而不是 innerHTML 是为了防止 XSS (跨站脚本) 攻击，确保文本内容被当作纯文本处理。
    if (text) {
        const textNode = document.createTextNode(text);
        contentElement.appendChild(textNode); // 将文本添加到内容容器中
    }
    
    // 5. 组装并显示消息
    messageElement.appendChild(contentElement); // 将内容容器添加到消息外层容器
    chatWindow.appendChild(messageElement); // 将完整的消息元素添加到聊天窗口
    
    // 6. 自动滚动到聊天窗口的底部，确保最新的消息总是可见的
    chatWindow.scrollTop = chatWindow.scrollHeight;
    
    // 7. 返回内容容器的引用，以便流式更新
    return contentElement;
}


/**
 * 清除图片预览区域的内容，并重置相关的状态变量。
 */
function clearImagePreview() {
    imagePreviewContainer.innerHTML = ''; // 清空预览区的 HTML
    attachedImageBase64 = null; // 重置 Base64 数据状态
    fileInput.value = ''; // 重置文件输入框的值。这很重要，否则用户无法连续选择同一张图片。
}

// --- 事件监听器设置 ---
// 这里我们将功能逻辑与用户的交互行为绑定起来。

// *** 新增: 监听模型选择下拉框的 'change' 事件 ***
modelSelect.addEventListener('change', () => {
    // 1. 清空对话历史记录
    conversationHistory = [];
    
    // 2. 清空聊天窗口的所有消息
    chatWindow.innerHTML = '';
    
    // 3. 显示一条提示消息，告知用户模型已切换和对话已重置
    // modelSelect.options[modelSelect.selectedIndex].text 可以获取到当前选中项的文本内容
    addMessage('assistant', `您已切换到模型：${modelSelect.options[modelSelect.selectedIndex].text}。对话已重置。`);
    
    // 4. 清空图片预览（以防切换模型前有图片未发送）
    clearImagePreview();

    // 5. 确保输入框清空并聚焦，方便用户开始新对话
    messageInput.value = '';
    messageInput.focus();
});


// 监听图片上传按钮的点击事件
uploadButton.addEventListener('click', () => {
    // 当用户点击我们自定义的漂亮按钮时，我们以编程方式触发那个隐藏的、样式丑陋的文件输入框的点击事件。
    // 这是一个常见的前端技巧，用于自定义文件上传按钮的样式。
    fileInput.click();
});

// 监听文件输入框的 'change' 事件。当用户选择了文件后，这个事件就会被触发。
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0]; // 获取用户选择的第一个文件
    
    // 确保用户选择的是一个图片文件
    if (file && file.type.startsWith('image/')) {
        // FileReader 是一个浏览器提供的 API，用于异步读取文件内容。
        const reader = new FileReader();
        
        // 设置当文件读取完成时的回调函数
        reader.onload = (event) => {
            // event.target.result 包含了文件的 Base64 数据 URL
            attachedImageBase64 = event.target.result;
            
            // --- 创建并显示图片预览 ---
            imagePreviewContainer.innerHTML = ''; // 先清空之前的预览
            const previewWrapper = document.createElement('div');
            previewWrapper.className = 'image-preview-item';
            
            const previewImg = document.createElement('img');
            previewImg.src = attachedImageBase64;
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-image-btn';
            removeBtn.innerHTML = '&times;'; // 显示一个 "×" 符号
            removeBtn.onclick = clearImagePreview; // 点击移除按钮时，调用清除函数
            
            previewWrapper.appendChild(previewImg);
            previewWrapper.appendChild(removeBtn);
            imagePreviewContainer.appendChild(previewWrapper);
        };
        
        // 启动文件读取过程。这会将整个图片文件编码成一个 Base64 字符串。
        reader.readAsDataURL(file);
    }
});

// 监听表单的 'submit' 事件。这是应用的核心交互逻辑。
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault(); // 阻止表单的默认提交行为（即刷新页面）
    
    const userMessage = messageInput.value.trim(); // 获取输入框中的文本，并移除首尾空格

    // 验证：必须有文本或图片才能发送
    if (!userMessage && !attachedImageBase64) {
        return; // 如果两者都为空，则不执行任何操作
    }

    const selectedModel = modelSelect.value; // 获取当前选择的模型

    // 1. 乐观更新 UI：立即在界面上显示用户的消息。
    addMessage('user', userMessage, attachedImageBase64);
    
    // 2. 更新对话历史：将用户的文本消息添加到历史记录中。
    conversationHistory.push({ role: 'user', content: userMessage });

    // 3. 准备发送 API 请求
    const currentImageBase64 = attachedImageBase64; // 临时保存当前要发送的图片数据

    // 4. 清理和禁用输入：在请求发送期间，清空输入框和预览，并禁用所有输入控件，防止用户重复发送。
    messageInput.value = '';
    clearImagePreview();
    sendButton.disabled = true;
    modelSelect.disabled = true;
    uploadButton.disabled = true;

    // 5. 创建一个空的 AI 消息气泡，用于接收流式响应
    const assistantMessageElement = addMessage('assistant', '');
    assistantMessageElement.parentElement.classList.add('loading'); // 添加加载样式
    let fullAssistantMessage = ''; // 用于累积完整的 AI 回复

    // 6. 使用 try...catch...finally 结构来健壮地处理异步 API 请求
    try {
        // 发送网络请求到我们的后端 API 代理
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: selectedModel,
                messages: conversationHistory,
                stream: true, // *** 启用流式传输 ***
                image: currentImageBase64,
            }),
        });

        // 如果响应不成功 (例如 4xx, 5xx 错误)
        if (!response.ok) {
            // 尝试从响应体中解析详细的 JSON 错误信息
            const errorData = await response.json().catch(() => {
                // 如果响应体不是有效的 JSON，则创建一个包含状态文本的错误对象
                return { error: `服务器错误，状态码: ${response.status} ${response.statusText}` };
            });
            // 抛出错误，由下方的 catch 块处理
            throw new Error(errorData.error || '发生未知错误');
        }

        // --- 处理流式响应 ---
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let isFirstChunk = true;

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break; // 读取完成
            }

            if (isFirstChunk) {
                assistantMessageElement.parentElement.classList.remove('loading'); // 移除加载样式
                isFirstChunk = false;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || ''; // 保留不完整的行在缓冲区

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.substring(6);
                    if (dataStr === '[DONE]') {
                        break;
                    }
                    try {
                        const data = JSON.parse(dataStr);
                        const delta = data.choices?.[0]?.delta?.content || '';
                        if (delta) {
                            fullAssistantMessage += delta;
                            // 直接更新消息内容元素的文本
                            assistantMessageElement.textContent = fullAssistantMessage;
                            chatWindow.scrollTop = chatWindow.scrollHeight; // 实时滚动
                        }
                    } catch (e) {
                        console.error('解析 SSE 数据块失败:', e, '数据块:', dataStr);
                    }
                }
            }
        }
        
        // 流结束后，将完整的消息存入历史记录
        if (fullAssistantMessage) {
            conversationHistory.push({ role: 'assistant', content: fullAssistantMessage });
        }

    } catch (error) {
        // 捕获所有在 try 块中发生的错误 (网络错误, HTTP 错误等)
        console.error('请求出错:', error);
        assistantMessageElement.parentElement.classList.remove('loading');
        assistantMessageElement.parentElement.classList.add('error'); // 添加错误样式
        assistantMessageElement.textContent = `抱歉，出错了: ${error.message}`;

    } finally {
        // 无论请求成功还是失败，finally 块中的代码都一定会执行
        // 7. 恢复界面：重新启用输入控件
        sendButton.disabled = false;
        modelSelect.disabled = false;
        uploadButton.disabled = false;
        messageInput.focus();
    }
});
