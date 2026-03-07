import { prisma } from './src/services/prisma.service';
async function run() {
    try {
        const user = await prisma.user.upsert({
            where: { telegramId: 12345n },
            update: {},
            create: { telegramId: 12345n }
        });
        
        console.log("User:", user.id);

        const s = await prisma.set.upsert({
            where: { quizletId: "test-set-1" },
            update: {
                title: "Test Set",
                savedBy: { connect: { id: user.id } }
            },
            create: {
                quizletId: "test-set-1",
                title: "Test Set",
                url: "http://example.com/test",
                userId: user.id,
                savedBy: { connect: { id: user.id } }
            }
        });
        
        console.log("Set:", s.id);
    } catch(e) {
        console.error("ERROR CAUGHT:");
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}
run();
