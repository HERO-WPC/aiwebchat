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
        const { request, env } = context;
        const { model, messages, image } = await request.json();

        const parseBase64 = (base64String) => {
            const match = base64String.match(/^data:(image\/.+);base64,(.+)$/);
            if (!match) return { mimeType: null, data: null };
            return { mimeType: match[1], data: match[2] };
        };

        let apiRequest;
        let isStream = false;

        const { mimeType, data: imageData } = image ? parseBase64(image) : { mimeType: null, data: null };
        const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';

        switch (model) {
            case 'gemini':
                const geminiApiKey = env.GEMINI_API_KEY;
                if (!geminiApiKey) throw new Error("GEMINI_API_KEY 环境变量未设置");

                const geminiContents = messages.map(msg => ({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }]
                }));

                if (imageData) {
                    const lastUserContent = geminiContents.filter(c => c.role === 'user').pop();
                    if (lastUserContent) {
                        lastUserContent.parts.push({
                            inline_data: { mime_type: mimeType, data: imageData }
                        });
                    }
                }

                apiRequest = {
                    url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: geminiContents })
                };
                break;

            case 'chatgpt':
                isStream = true;

                const openaiApiKey = env.OPENAI_API_KEY;
                if (!openaiApiKey) throw new Error("OPENAI_API_KEY 环境变量未设置");

                let finalMessagesChatgpt = [];
                finalMessagesChatgpt.push({ role: 'system', content: '你是一个乐于助人的AI助手。' });

                if (messages && messages.length > 0) {
                    messages.forEach((msg, index) => {
                        if (index < messages.length - 1) {
                            finalMessagesChatgpt.push({
                                role: msg.role,
                                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                            });
                        }
                    });
                }

                const currentUserMessageChatgpt = messages[messages.length - 1];
                if (currentUserMessageChatgpt) {
                    if (imageData && image) {
                        finalMessagesChatgpt.push({
                            role: 'user',
                            content: [
                                { type: 'text', text: typeof currentUserMessageChatgpt.content === 'string' ? currentUserMessageChatgpt.content : '' },
                                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } }
                            ]
                        });
                    } else {
                        finalMessagesChatgpt.push({
                            role: 'user',
                            content: typeof currentUserMessageChatgpt.content === 'string' ? currentUserMessageChatgpt.content : JSON.stringify(currentUserMessageChatgpt.content)
                        });
                    }
                }

                const chatanywhereApiHostChatgpt = 'https://api.chatanywhere.tech';

                apiRequest = {
                    url: `${chatanywhereApiHostChatgpt}/v1/chat/completions`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${openaiApiKey}`
                    },
                    body: JSON.stringify({
                        model: "gpt-4o",
                        messages: finalMessagesChatgpt,
                        stream: true
                    })
                };
                break;

            case 'deepseek':
                isStream = true;

                const openrouterApiKey = env.OPENROUTER_API_KEY;
                // !!! 增加了日志和更严格的检查 !!!
                if (!openrouterApiKey || openrouterApiKey.trim() === '') {
                    console.error("Cloudflare Worker Error: OPENROUTER_API_KEY 环境变量未设置或为空。请检查 Worker 配置。");
                    throw new Error("OPENROUTER_API_KEY 环境变量未设置或为空");
                }
                console.log("DEBUG: OPENROUTER_API_KEY 已加载。"); // 确认加载

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
                        "stream": true
                    })
                };
                break;


            case 'qwen':
                const qwenApiKey = env.QWEN_API_KEY;
                if (!qwenApiKey) throw new Error("QWEN_API_KEY 环境变量未设置");

                const qwenMessages = messages.map(msg => {
                    if (imageData && msg.role === 'user' && msg.content === lastUserMessage) {
                        return {
                            role: msg.role,
                            content: [
                                { image: `data:${mimeType};base64,${imageData}` },
                                { text: msg.content }
                            ]
                        };
                    }
                    return msg;
                });

                apiRequest = {
                    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${qwenApiKey}` },
                    body: JSON.stringify({ model: "qwen-vl-plus", input: { messages: qwenMessages } })
                };
                break;

            default:
                return new Response(JSON.stringify({ error: '选择了无效的模型' }), { status: 400 });
        }

        const apiResponse = await fetch(apiRequest.url, apiRequest);

        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            console.error(`来自 ${model} 的 API 错误响应:`, errorText);
            // 确保错误消息是可 JSON 字符串化的
            const errorMessage = `来自 ${model} 的 API 错误或上游 API 响应非 2xx: ${errorText.substring(0, 200)}`; // 截断避免过长
            throw new Error(errorMessage);
        }

        if (isStream) {
            const responseHeaders = new Headers(apiResponse.headers);
            responseHeaders.set('Content-Type', 'text/event-stream');
            responseHeaders.set('Cache-Control', 'no-cache');
            responseHeaders.set('Connection', 'keep-alive');
            responseHeaders.set('X-Accel-Buffering', 'no');

            return new Response(apiResponse.body, {
                status: apiResponse.status,
                headers: responseHeaders,
            });
        } else {
            const data = await apiResponse.json();

            let reply = '';
            switch (model) {
                case 'gemini':
                    reply = data.candidates[0].content.parts[0].text;
                    break;
                case 'qwen':
                    reply = data.output.choices[0].message.content[0].text;
                    break;
            }

            return new Response(JSON.stringify({ reply }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        console.error('Cloudflare Function 内部错误:', error);
        // --- 改进的错误响应处理 ---
        // 确保 error.message 是一个字符串，以防万一它不是
        const errorMessage = typeof error.message === 'string' ? error.message : '未知服务器错误';
        return new Response(JSON.stringify({ error: errorMessage }), { status: 500 });
    }
}
