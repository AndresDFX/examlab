import { createFileRoute } from "@tanstack/react-router";

import { TakeExam } from "@/modules/exams/TakeExamScreen";

/**
 * Este archivo exporta SOLO `Route`, y tiene que seguir así: el plugin de
 * TanStack separa el componente en su propio chunk únicamente cuando el archivo
 * de ruta no exporta nada más. La pantalla vive en `TakeExamScreen` — ver el
 * encabezado de ese módulo para lo que se rompe si se vuelve a mezclar.
 */
export const Route = createFileRoute("/app/student/take/$examId")({
  component: function PantallaDeToma() {
    const { examId } = Route.useParams();
    return <TakeExam examId={examId} />;
  },
});
