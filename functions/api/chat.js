/**
 * 这是在 Cloudflare Functions 上运行的后端 API 代理。
 * 它的核心职责有三个：
 * 1. 安全性：作为前端和各大模型 API 之间的中间层，隐藏并保护您的 API 密钥。密钥存储在 Cloudflare 的环境变量中，绝不会暴露给前端。
 * 2. 统一性：为前端提供一个统一的、简单的 API 接口 (`/api/chat`)。无论前端选择哪个模型，都只与这个接口通信。
 * 3. 适配性：将前端发来的统一格式的数据，转换成各个大模型 API 所要求的、各不相同的特定格式。
 */

// Cloudflare Functions 的入口点。每个发往此路由的 POST 请求都会触发这个函数。
export async function onRequestPost(context) {
    try {
        // `context` 对象包含了请求的所有信息。
        // `request` 是浏览器发来的请求对象。
        // `env` 是一个包含了您在 Cloudflare 后台设置的所有环境变量（如 API 密钥）的对象。
        const { request, env } = context;

        // 从请求的 JSON 体中解析出前端发送的数据。
        // `image` 字段可能存在也可能不存在。
        const { model, messages, image } = await request.json();

        /**
         * 辅助函数：用于从 Base64 数据 URL 中解析出 MIME 类型和纯 Base64 数据。
         * 例如，从 "data:image/png;base64,iVBw0KGgo..." 中提取出 "image/png" 和 "iVBw0KGgo..."
         * @param {string} base64String - 完整的数据 URL。
         * @returns {{mimeType: string|null, data: string|null}}
         */
        const parseBase64 = (base64String) => {
            const match = base64String.match(/^data:(image\/.+);base64,(.+)$/);
            if (!match) return { mimeType: null, data: null };
            return { mimeType: match[1], data: match[2] };
        };

        let apiRequest; // 这个变量将用于存储最终构建好的、要发送给目标 API 的请求对象。
        let isStream = false; // 新增变量来判断是否是流式请求，默认非流式

        // 如果前端发送了图片，就解析它；否则，mimeType 和 imageData 都为 null。
        const { mimeType, data: imageData } = image ? parseBase64(image) : { mimeType: null, data: null };

        // 获取最后一条用户消息的文本内容，这在某些模型的请求构建中会用到。
        const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';

        // --- 模型适配层 ---
        // 这是此后端服务的核心逻辑。根据前端选择的模型，构建不同的 API 请求。
        switch (model) {
            case 'gemini':
                const geminiApiKey = env.GEMINI_API_KEY;
                if (!geminiApiKey) throw new Error("GEMINI_API_KEY 环境变量未设置");

                // Gemini 的 API 格式要求将角色从 'assistant' 映射到 'model'。
                const geminiContents = messages.map(msg => ({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }] // 每个消息的内容都放在一个 parts 数组里
                }));

                // 如果有图片，需要将图片数据作为另一个 "part" 添加到最后一条用户消息中。
                if (imageData) {
                    const lastUserContent = geminiContents.filter(c => c.role === 'user').pop();
                    if (lastUserContent) {
                        lastUserContent.parts.push({
                            inline_data: { mime_type: mimeType, data: imageData }
                        });
                    }
                }

                apiRequest = {
                    url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, // 建议使用更强的模型，如 gemini-2.1-pro
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: geminiContents })
                };
                // Gemini API 默认是非流式，如果需要流式需要将 url 改为 :streamGenerateContent
                // isStream = true; // 如果 Gemini API 支持流式且你想启用，这里可以设置为 true
                break;

            case 'chatgpt':
                isStream = true; // ChatGPT (OpenAI 兼容) 默认启用流式传输

                const openaiApiKey = env.OPENAI_API_KEY; // 依然使用 ChatAnywhere 的 API Key
                if (!openaiApiKey) throw new Error("OPENAI_API_KEY 环境变量未设置");

                let finalMessagesChatgpt = [];

                // 添加系统消息（可选，用于设定AI的行为）
                finalMessagesChatgpt.push({ role: 'system', content: '你是一个乐于助人的AI助手。' });

                // 添加历史对话（如果存在）
                if (messages && messages.length > 0) {
                    messages.forEach((msg, index) => {
                        // 假设除了最后一条，其余消息都是纯文本
                        if (index < messages.length - 1) { // 除了最后一条消息
                            finalMessagesChatgpt.push({
                                role: msg.role,
                                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                            });
                        }
                    });
                }

                // 处理当前的用户输入，包括可能的图片
                const currentUserMessageChatgpt = messages[messages.length - 1];
                if (currentUserMessageChatgpt) {
                    if (imageData && image) {
                        // 多模态消息
                        finalMessagesChatgpt.push({
                            role: 'user',
                            content: [
                                { type: 'text', text: typeof currentUserMessageChatgpt.content === 'string' ? currentUserMessageChatgpt.content : '' }, // 文本部分
                                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } } // 使用 mimeType
                            ]
                        });
                    } else {
                        // 纯文本消息
                        finalMessagesChatgpt.push({
                            role: 'user',
                            content: typeof currentUserMessageChatgpt.content === 'string' ? currentUserMessageChatgpt.content : JSON.stringify(currentUserMessageChatgpt.content)
                        });
                    }
                }

                const chatanywhereApiHostChatgpt = 'https://api.chatanywhere.tech'; // 国内使用
                // const chatanywhereApiHostChatgpt = 'https://api.chatanywhere.org'; // 国外使用

                apiRequest = {
                    url: `${chatanywhereApiHostChatgpt}/v1/chat/completions`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${openaiApiKey}`
                    },
                    body: JSON.stringify({
                        model: "gpt-4o", // gpt-4o 或 ChatAnywhere 提供的 CA 系列模型
                        messages: finalMessagesChatgpt,
                        stream: true // 明确设置 stream 为 true
                    })
                };
                break;


            case 'deepseek':
                isStream = true; // Deepseek (OpenRouter) 默认启用流式传输

                const openrouterApiKey = env.OPENROUTER_API_KEY;
                if (!openrouterApiKey) throw new Error("OPENROUTER_API_KEY 环境变量未设置");

                let finalMessagesDeepseek = [];
                finalMessagesDeepseek.push({ role: 'system', content: '你是一个乐于助人的AI助手。' });

                if (messages && messages.length > 0) {
                    messages.forEach((msg) => {
                        finalMessagesDeepseek.push({
                            role: msg.role,
                            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                        });
                    });
                }

                const currentUserMessageDeepseek = messages[messages.length - 1];
                if (currentUserMessageDeepseek) {
                    // OpenRouter 上的 deepseek-chat-v3.1 模型目前不直接支持多模态（图片输入）
                    finalMessagesDeepseek.push({
                        role: 'user',
                        content: typeof currentUserMessageDeepseek.content === 'string' ? currentUserMessageDeepseek.content : JSON.stringify(currentUserMessageDeepseek.content)
                    });
                }

                const openRouterApiHost = 'https://openrouter.ai';

                apiRequest = {
                    url: `${openRouterApiHost}/api/v1/chat/completions`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${openrouterApiKey}`,
                        "HTTP-Referer": env.YOUR_SITE_URL || "https://example.com",
                        "X-Title": env.YOUR_SITE_NAME || "My AI Chat App"
                    },
                    body: JSON.stringify({
                        "model": "deepseek/deepseek-chat-v3.1:free",
                        "messages": finalMessagesDeepseek,
                        "stream": true // 明确设置 stream 为 true
                    })
                };
                break;


            case 'qwen':
                // Qwen API 默认是非流式，如果需要流式，查阅其文档并调整
                // isStream = true; // 如果 Qwen API 支持流式且你想启用，这里可以设置为 true

                const qwenApiKey = env.QWEN_API_KEY;
                if (!qwenApiKey) throw new Error("QWEN_API_KEY 环境变量未设置");

                // 通义千问的多模态格式也要求一个内容数组，但字段名不同。
                const qwenMessages = messages.map(msg => {
                    if (imageData && msg.role === 'user' && msg.content === lastUserMessage) {
                        return {
                            role: msg.role,
                            content: [
                                { image: `data:${mimeType};base64,${imageData}` }, // 千问通常接受 Base64 数据 URL 或远程 URL
                                { text: msg.content }
                            ]
                        };
                    }
                    return msg; // 其他消息保持原样
                });

                apiRequest = {
                    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${qwenApiKey}` },
                    body: JSON.stringify({ model: "qwen-vl-plus", input: { messages: qwenMessages } })
                };
                break;

            default:
                // 如果前端发送了一个未知的模型名称，返回一个错误。
                return new Response(JSON.stringify({ error: '选择了无效的模型' }), { status: 400 });
        }

        // --- 发送请求与返回响应 ---

        // 使用 fetch API 从 Cloudflare 的服务器向目标大模型 API 发送请求。
        const apiResponse = await fetch(apiRequest.url, apiRequest);

        // 如果 API 返回了非 2xx 的状态码，说明请求失败。
        if (!apiResponse.ok) {
            const errorText = await apiResponse.text(); // 读取错误响应体
            console.error(`来自 ${model} 的 API 错误响应:`, errorText); // 打印详细错误响应
            throw new Error(`来自 ${model} 的 API 错误: ${errorText}`);
        }

        // 根据 isStream 变量来决定如何处理响应
        if (isStream) {
            // 如果是流式请求，直接返回原始的 Response 对象，Cloudflare Workers 会处理流转发
            // 通常，流式响应的 Content-Type 应该是 text/event-stream
            return new Response(apiResponse.body, {
                status: apiResponse.status,
                headers: {
                    'Content-Type': apiResponse.headers.get('Content-Type') || 'text/event-stream', // 确保传输 Content-Type
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                }
            });
        } else {
            // 如果是非流式请求，解析 JSON 响应
            const data = await apiResponse.json();

            // --- 响应解析层 ---
            // 从不同模型的成功响应体中，解析出我们需要的回复文本。
            let reply = '';
            switch (model) {
                case 'gemini':
                    reply = data.candidates[0].content.parts[0].text;
                    break;
                // 注意：由于 chatgpt 和 deepseek 现在都是流式，这部分的 case 将不再被触发。
                // 如果将来某个模型被设置为非流式，它会在这里处理。
                case 'qwen':
                    reply = data.output.choices[0].message.content[0].text;
                    break;
            }

            // 将最终提取出的纯文本回复包装成 JSON 格式，发送回前端。
            return new Response(JSON.stringify({ reply }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        // 如果在整个 `try` 块的任何地方发生错误，都会被这里捕获。
        console.error('Cloudflare Function 内部错误:', error); // 在 Cloudflare 的日志中打印详细错误，方便排查。
        // 向前端返回一个统一的 500 错误响应。
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}
