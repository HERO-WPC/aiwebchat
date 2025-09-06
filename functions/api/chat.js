// This is the backend API proxy running on Cloudflare Functions.
// It securely handles API requests to different AI models, including multimodal (image) inputs.

export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const { model, messages, image } = await request.json(); // Extract image from request

        // Helper function to extract base64 data and mime type from a data URL
        const parseBase64 = (base64String) => {
            const match = base64String.match(/^data:(image\/.+);base64,(.+)$/);
            if (!match) return { mimeType: null, data: null };
            return { mimeType: match[1], data: match[2] };
        };

        let apiRequest;
        const { mimeType, data: imageData } = image ? parseBase64(image) : { mimeType: null, data: null };

        // Get the last user message text
        const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';

        switch (model) {
            case 'gemini':
                const geminiApiKey = env.GEMINI_API_KEY;
                if (!geminiApiKey) throw new Error("GEMINI_API_KEY is not set");

                // Gemini requires a specific content format for images
                const geminiContents = messages.map(msg => ({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }]
                }));

                if (imageData) {
                    // Find the last user message and add the image part to it
                    const lastUserContent = geminiContents.filter(c => c.role === 'user').pop();
                    if (lastUserContent) {
                        lastUserContent.parts.push({
                            inline_data: { mime_type: mimeType, data: imageData }
                        });
                    }
                }
                
                apiRequest = {
                    url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent?key=${geminiApiKey}`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: geminiContents })
                };
                break;

            case 'chatgpt':
                const openaiApiKey = env.OPENAI_API_KEY;
                if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not set");

                const gptMessages = [...messages];
                if (imageData) {
                    // For GPT-4o, add the image URL to the last user message's content
                    const lastUserMsg = gptMessages.filter(m => m.role === 'user').pop();
                    if (lastUserMsg) {
                        lastUserMsg.content = [
                            { type: "text", text: lastUserMsg.content },
                            { type: "image_url", image_url: { url: image } }
                        ];
                    }
                }

                apiRequest = {
                    url: 'https://api.openai.com/v1/chat/completions',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiApiKey}` },
                    body: JSON.stringify({ model: "gpt-4o", messages: gptMessages })
                };
                break;

            case 'deepseek':
                const deepseekApiKey = env.DEEPSEEK_API_KEY;
                if (!deepseekApiKey) throw new Error("DEEPSEEK_API_KEY is not set");
                
                const dsMessages = [...messages];
                if (imageData) {
                     const lastUserMsg = dsMessages.filter(m => m.role === 'user').pop();
                     if(lastUserMsg) {
                        lastUserMsg.content = [
                            { type: "text", text: lastUserMsg.content },
                            { type: "image_url", image_url: { url: image } }
                        ];
                     }
                }

                apiRequest = {
                    url: 'https://api.deepseek.com/chat/completions',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekApiKey}` },
                    body: JSON.stringify({ model: "deepseek-vl-chat", messages: dsMessages })
                };
                break;

            case 'qwen':
                const qwenApiKey = env.QWEN_API_KEY;
                if (!qwenApiKey) throw new Error("QWEN_API_KEY is not set");

                const qwenMessages = messages.map(msg => {
                    if (msg.role === 'user' && imageData && msg.content === lastUserMessage) {
                        // This is the message with the image
                        return {
                            role: msg.role,
                            content: [
                                { image: image }, // Qwen expects the data URL directly
                                { text: msg.content }
                            ]
                        };
                    }
                    return { role: msg.role, content: msg.content };
                });

                apiRequest = {
                    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${qwenApiKey}` },
                    body: JSON.stringify({ model: "qwen-vl-plus", input: { messages: qwenMessages } })
                };
                break;

            default:
                return new Response(JSON.stringify({ error: 'Invalid model selected' }), { status: 400 });
        }

        const apiResponse = await fetch(apiRequest.url, apiRequest);
        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            throw new Error(`API Error from ${model}: ${errorText}`);
        }
        const data = await apiResponse.json();

        let reply = '';
        switch (model) {
            case 'gemini':
                reply = data.candidates[0].content.parts[0].text;
                break;
            case 'chatgpt':
            case 'deepseek':
                reply = data.choices[0].message.content;
                break;
            case 'qwen':
                reply = data.output.choices[0].message.content[0].text;
                break;
        }

        return new Response(JSON.stringify({ reply }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error in Cloudflare Function:', error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}