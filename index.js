const { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    EmbedBuilder 
} = require('discord.js');

const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    getVoiceConnection,
    VoiceConnectionStatus
} = require('@discordjs/voice');

const fs = require('fs');
const path = require('path');
const https = require('https');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// تخزين التايمرات النشطة لكل سيرفر
const activeTimers = new Map();

client.once('ready', () => {
    console.log(`🤖 البوت شغال وجاهز باسم: ${client.user.tag}`);
});

// 1. أمر !setsound لحفظ ملف الصوت وأمر !setup لتشغيل اللوحة
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // أمر !setsound
    if (message.content.trim() === '!setsound') {
        const attachment = message.attachments.first();
        if (!attachment || !attachment.name.endsWith('.mp3')) {
            return message.reply('❌ يرجى إرفاق ملف صوتي بصيغة `.mp3` مع الأمر!');
        }

        const filePath = path.join(__dirname, 'alarm.mp3');
        const file = fs.createWriteStream(filePath);

        https.get(attachment.url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                message.reply('✅ تم حفظ ملف الصوت بنجاح كـ `alarm.mp3`!');
            });
        }).on('error', (err) => {
            fs.unlink(filePath, () => {});
            message.reply('❌ حدث خطأ أثناء تحميل الملف الصوت.');
        });
        return;
    }

    // أمر !setup لتشغيل لوحة التحكم
    if (message.content.trim() === '!setup') {
        const hasRole = message.member.roles.cache.some(r => r.name === 'Timer Admin');
        if (!hasRole) {
            return message.reply('❌ عفواً، هذا الأمر مخصص فقط لمن يحملون رتبة `Timer Admin`.');
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('time_15').setLabel('15 دقيقة').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('time_25').setLabel('25 دقيقة').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('time_50').setLabel('50 دقيقة').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('custom_time').setLabel('وقت مخصص').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('cancel_timer').setLabel('🛑 إلغاء التايمر').setStyle(ButtonStyle.Danger)
        );

        await message.channel.send({
            content: '📋 **لوحة التحكم بالتايمر للمكالمة الصوتية**\nاضغطي على الزر بالأسفل لتحديد المدة:',
            components: [row]
        });
    }
});

// 2. التفاعل مع الأزرار والـ Modals
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() || interaction.isModalSubmit()) {
        const hasRole = interaction.member.roles.cache.some(r => r.name === 'Timer Admin');
        if (!hasRole) {
            return interaction.reply({ content: '❌ عفواً، الأزرار مخصصة فقط لرتبة `Timer Admin`.', ephemeral: true });
        }
    }

    if (interaction.isButton()) {
        const guildId = interaction.guildId;

        if (interaction.customId === 'cancel_timer') {
            if (!activeTimers.has(guildId)) {
                return interaction.reply({ content: '⚠️ لا يوجد تايمر يعمل حالياً لإلغائه.', ephemeral: true });
            }

            stopTimer(guildId, 'تم إلغاء التايمر بطلب من المسئول.');
            return interaction.reply({ content: '🛑 تم إلغاء التايمر وإرجاع اسم الروم وفصل البوت.', ephemeral: true });
        }

        if (interaction.customId === 'custom_time') {
            const modal = new ModalBuilder()
                .setCustomId('custom_time_modal')
                .setTitle('تحديد وقت مخصص');

            const timeInput = new TextInputBuilder()
                .setCustomId('minutes_input')
                .setLabel('أدخلي عدد الدقائق:')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('مثال: 45')
                .setRequired(true);

            const firstActionRow = new ActionRowBuilder().addComponents(timeInput);
            modal.addComponents(firstActionRow);

            await interaction.showModal(modal);
            return;
        }

        if (interaction.customId.startsWith('time_')) {
            if (activeTimers.has(guildId)) {
                return interaction.reply({ content: '⚠️ هناك جلسة تايمر شغالة بالفعل في هذا السيرفر!', ephemeral: true });
            }

            const minutes = parseInt(interaction.customId.split('_')[1]);
            await startTimerSession(interaction, minutes);
        }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'custom_time_modal') {
        const guildId = interaction.guildId;
        if (activeTimers.has(guildId)) {
            return interaction.reply({ content: '⚠️ هناك جلسة تايمر شغالة بالفعل في هذا السيرفر!', ephemeral: true });
        }

        const inputMins = parseInt(interaction.fields.getTextInputValue('minutes_input'));
        if (isNaN(inputMins) || inputMins <= 0) {
            return interaction.reply({ content: '❌ يرجى إدخال رقم صحيح وموجب للدقائق.', ephemeral: true });
        }

        await startTimerSession(interaction, inputMins);
    }
});

// 3. دالة بدء التايمر
async function startTimerSession(interaction, minutes) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        return interaction.reply({ content: '❌ يجب أن تكوني داخل روم صوتي لتشغيل التايمر!', ephemeral: true });
    }

    await interaction.deferReply();

    const guildId = interaction.guildId;
    const totalSeconds = minutes * 60;
    let secondsLeft = totalSeconds;
    const originalChannelName = voiceChannel.name;

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    const statusMessage = await interaction.editReply({
        content: generateStatusMessage(secondsLeft, totalSeconds)
    });

    safeSetChannelName(voiceChannel, `${originalChannelName} | ⏳ ${formatTime(secondsLeft)}`);

    let lastChannelRename = Date.now();

    const intervalId = setInterval(async () => {
        secondsLeft -= 5;

        if (secondsLeft > 0) {
            await statusMessage.edit({
                content: generateStatusMessage(secondsLeft, totalSeconds)
            }).catch(() => {});

            if (Date.now() - lastChannelRename >= 3 * 60 * 1000) {
                safeSetChannelName(voiceChannel, `${originalChannelName} | ⏳ ${formatTime(secondsLeft)}`);
                lastChannelRename = Date.now();
            }
        } else {
            clearInterval(intervalId);

            playAlarmSound(connection);

            safeSetChannelName(voiceChannel, originalChannelName);

            const members = voiceChannel.members.filter(m => !m.user.bot);
            const memberMentions = members.map(m => m.toString()).join(', ') || 'لا يوجد أبطال في الروم';

            const statsEmbed = new EmbedBuilder()
                .setDescription(`عاش جداً يا أبطال! إنجاز مميز واستراحة مستحقة ☕✨\n\n👥 **الحضور:**\n${memberMentions}`)
                .addFields(
                    { name: '⏱️ إجمالي مدة الجلسة', value: `**${minutes} دقيقة**`, inline: true },
                    { name: '🔥 عدد الأبطال', value: `**${members.size} مشارك**`, inline: true }
                )
                .setColor('#2b2d31')
                .setTimestamp();

            await statusMessage.edit({
                content: `🔔 ${memberMentions} **انتهى الوقت!**`,
                embeds: [statsEmbed],
                components: []
            }).catch(() => {});

            setTimeout(() => {
                if (connection) connection.destroy();
                activeTimers.delete(guildId);
            }, 10000);
        }
    }, 5000);

    activeTimers.set(guildId, {
        intervalId,
        voiceChannel,
        originalChannelName,
        connection
    });
}

function stopTimer(guildId, reason) {
    const timerData = activeTimers.get(guildId);
    if (!timerData) return;

    clearInterval(timerData.intervalId);

    safeSetChannelName(timerData.voiceChannel, timerData.originalChannelName);

    if (timerData.connection) {
        timerData.connection.destroy();
    }

    activeTimers.delete(guildId);
}

async function safeSetChannelName(channel, name) {
    try {
        await channel.setName(name);
    } catch (error) {
        console.error('Discord Rate Limit Error on Channel Name:', error);
    }
}

function generateProgressBar(secondsLeft, totalSeconds) {
    const totalBlocks = 10;
    const percentage = Math.max(0, Math.min(100, Math.round(((totalSeconds - secondsLeft) / totalSeconds) * 100)));
    const filledBlocks = Math.round((percentage / 100) * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;

    const bar = '▓'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
    return `[${bar}] **${percentage}%**`;
}

function generateStatusMessage(secondsLeft, totalSeconds) {
    const progress = generateProgressBar(secondsLeft, totalSeconds);
    const timeStr = formatTime(secondsLeft);
    return `⏳ **جلسة المذاكرة شغالة...**\nالوقت المتبقي: **${timeStr}** 📚\nالتقدم: ${progress}`;
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function playAlarmSound(connection) {
    if (!connection) return;
    try {
        const player = createAudioPlayer();
        const soundPath = fs.existsSync(path.join(__dirname, 'alarm.mp3'))
            ? path.join(__dirname, 'alarm.mp3')
            : null;

        if (soundPath) {
            const resource = createAudioResource(soundPath);
            player.play(resource);
            connection.subscribe(player);
        }
    } catch (error) {
        console.error('Audio Error:', error);
    }
}

client.login(process.env.DISCORD_TOKEN);
