-- CreateTable
CREATE TABLE "_UserSavedSets" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_UserSavedSets_AB_unique" ON "_UserSavedSets"("A", "B");

-- CreateIndex
CREATE INDEX "_UserSavedSets_B_index" ON "_UserSavedSets"("B");

-- AddForeignKey
ALTER TABLE "_UserSavedSets" ADD CONSTRAINT "_UserSavedSets_A_fkey" FOREIGN KEY ("A") REFERENCES "Set"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserSavedSets" ADD CONSTRAINT "_UserSavedSets_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
